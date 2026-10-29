import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { entries } from "./tree";

export type RunResult = { exitCode: number; output: string; duration: number };
export type Runner = {
  isolation?: "isolated" | "unisolated";
  check: (
    snapshot: string,
    config: any,
    deadline: number,
  ) => Promise<RunResult>;
  acceptance: (
    snapshot: string,
    config: any,
    suite: any,
    deadline: number,
  ) => Promise<{ passed: boolean; criteria: any[] }>;
};

export function suiteDigest(path: string): string {
  if (statSync(path).isFile())
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  const items = entries(path).filter((item) => !item.dir);
  const lines = items
    .map(
      (item) =>
        `${createHash("sha256").update(item.bytes).digest("hex")}  ${item.path}\n`,
    )
    .sort()
    .join("");
  return "sha256:" + createHash("sha256").update(lines).digest("hex");
}

async function execute(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  deadline: number,
): Promise<RunResult> {
  const start = Date.now();
  const timeout = Math.min(30000, deadline - start);
  if (timeout <= 0) throw Error("DEADLINE");
  let proc;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw Error("SANDBOX_UNAVAILABLE");
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) throw Error("CHECK_TIMEOUT");
    return {
      exitCode: code,
      output: (out + "\n" + err).slice(0, 16000),
      duration: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeArgv(argv: unknown): string[] {
  if (
    !Array.isArray(argv) ||
    argv.length < 3 ||
    !["python", "python3"].includes(argv[0]) ||
    argv[1] !== "-m" ||
    argv[2] !== "pytest" ||
    argv.some((x) => typeof x !== "string")
  )
    throw Error("CHECK_NOT_ALLOWED");
  return argv as string[];
}

function reports(xml: string): { id: string; passed: boolean }[] {
  const results: { id: string; passed: boolean }[] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] || "";
    const name = /\bname="([^"]+)"/.exec(attrs)?.[1];
    const className = /\bclassname="([^"]+)"/.exec(attrs)?.[1];
    if (name && className)
      results.push({
        id: `${className}::${name}`.slice(0, 500),
        passed: !/<(?:failure|error|skipped)\b/.test(match[2] || ""),
      });
  }
  return results;
}

export function makeRunner(allowUnisolated: boolean): Runner {
  const engine = Bun.which("podman") || Bun.which("docker");
  if (!engine && !allowUnisolated) throw Error("SANDBOX_UNAVAILABLE");
  const isolation = allowUnisolated ? "unisolated" : "isolated";
  const engineEnv: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: homedir(),
  };
  if (process.env.XDG_RUNTIME_DIR)
    engineEnv.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  if (process.env.DOCKER_HOST) engineEnv.DOCKER_HOST = process.env.DOCKER_HOST;
  if (isolation === "isolated") {
    const podman = basename(engine!).includes("podman");
    const info = Bun.spawnSync(
      [
        engine!,
        "info",
        "--format",
        podman ? "{{.Host.Security.Rootless}}" : "{{json .SecurityOptions}}",
      ],
      { env: engineEnv, timeout: 5000 },
    );
    const output = info.stdout.toString().trim();
    if (
      info.exitCode !== 0 ||
      (podman ? output !== "true" : !output.includes("rootless"))
    )
      throw Error("SANDBOX_UNAVAILABLE");
  }
  const image = process.env.DEVPILOT_CONTAINER_IMAGE || "";
  if (isolation === "isolated" && !/^.+@sha256:[a-f0-9]{64}$/.test(image))
    throw Error("PINNED_CONTAINER_IMAGE_REQUIRED");
  const site = Bun.spawnSync(["python3", "-m", "site", "--user-site"], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: homedir() },
  })
    .stdout.toString()
    .trim();
  const environment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    PYTHONPATH: site,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
  };
  return {
    isolation,
    async check(snapshot, config, deadline) {
      const argv = safeArgv(config.check.argv);
      if (isolation === "unisolated")
        return execute(
          ["python3", ...argv.slice(1)],
          snapshot,
          environment,
          deadline,
        );
      return execute(
        [
          engine!,
          "run",
          "--rm",
          "--pull=never",
          "--network=none",
          "--read-only",
          "--cap-drop=all",
          "--security-opt=no-new-privileges",
          "--pids-limit=64",
          "--memory=512m",
          "--cpus=1",
          "--tmpfs",
          "/tmp:rw,nosuid,size=64m",
          "--volume",
          `${snapshot}:/repo:ro`,
          "--workdir",
          "/repo",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          "--env",
          "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
          image,
          ...argv,
        ],
        snapshot,
        engineEnv,
        deadline,
      );
    },
    async acceptance(snapshot, config, suite, deadline) {
      if (!suite?.path || suiteDigest(suite.path) !== suite.digest)
        throw Error("SUITE_CHANGED");
      safeArgv(config.acceptance.argv);
      const temp = mkdtempSync(join(tmpdir(), "devpilot-acceptance-"));
      try {
        const report = join(temp, "report.xml");
        let result: RunResult;
        if (isolation === "unisolated") {
          result = await execute(
            [
              "python3",
              "-m",
              "pytest",
              "-q",
              "-p",
              "no:cacheprovider",
              "--rootdir",
              temp,
              "--junitxml",
              report,
              suite.path,
            ],
            temp,
            { ...environment, CANDIDATE_DIR: resolve(snapshot) },
            deadline,
          );
        } else {
          result = await execute(
            [
              engine!,
              "run",
              "--rm",
              "--pull=never",
              "--network=none",
              "--read-only",
              "--cap-drop=all",
              "--security-opt=no-new-privileges",
              "--pids-limit=64",
              "--memory=512m",
              "--cpus=1",
              "--tmpfs",
              "/tmp:rw,nosuid,size=64m",
              "--volume",
              `${snapshot}:/candidate:ro`,
              "--volume",
              `${suite.path}:/private:ro`,
              "--volume",
              `${temp}:/results:rw`,
              "--workdir",
              "/tmp",
              "--env",
              "CANDIDATE_DIR=/candidate",
              "--env",
              "PYTHONDONTWRITEBYTECODE=1",
              "--env",
              "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
              image,
              "python",
              "-m",
              "pytest",
              "-q",
              "-p",
              "no:cacheprovider",
              "--rootdir",
              "/tmp",
              "--junitxml",
              "/results/report.xml",
              "/private",
            ],
            temp,
            engineEnv,
            deadline,
          );
        }
        let criteria: { id: string; passed: boolean }[] = [];
        try {
          criteria = reports(readFileSync(report, "utf8"));
        } catch {
          /* Missing report is an infrastructure failure. */
        }
        if (suiteDigest(suite.path) !== suite.digest)
          throw Error("SUITE_CHANGED");
        return {
          passed:
            result.exitCode === 0 &&
            criteria.length > 0 &&
            criteria.every((c) => c.passed),
          criteria,
        };
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  };
}
