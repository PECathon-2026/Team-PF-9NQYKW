import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { entries } from "./tree";
import { verifyCandidate } from "./verifier";

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
  const unshare = isolation === "unisolated" ? Bun.which("unshare") : null;
  const setpriv = isolation === "unisolated" ? Bun.which("setpriv") : null;
  const candidatePrefix =
    unshare && setpriv
      ? [
          unshare,
          "--user",
          "--map-root-user",
          "--net",
          "--",
          setpriv,
          "--bounding-set=-all",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--no-new-privs",
        ]
      : [];
  const networkPrefix =
    candidatePrefix.length > 0 &&
    Bun.spawnSync([...candidatePrefix, "true"], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" },
      stdout: "ignore",
      stderr: "ignore",
      timeout: 2000,
    }).exitCode === 0
      ? candidatePrefix
      : [];
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
      safeArgv(config.acceptance.argv);
      return verifyCandidate(snapshot, suite, deadline, {
        isolation,
        engine,
        image,
        engineEnv,
        environment,
        site,
        networkPrefix,
        execute,
        suiteDigest,
      });
    },
  };
}
