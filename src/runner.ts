import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
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

/** Combined stdout+stderr kept per run; the rest is drained and discarded. */
export const OUTPUT_CAP = 16000;
async function capped(stream: ReadableStream<Uint8Array>, cap: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0,
    truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (size < cap) {
      const take = value.subarray(0, cap - size);
      chunks.push(take);
      size += take.length;
      if (take.length < value.length) truncated = true;
    } else truncated = true;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export type Container = {
  engine: string;
  name: string;
  env: Record<string, string>;
};
/** Force-stop and remove a named container; safe if it is already gone. */
export async function removeContainer(container: Container) {
  for (const args of [
    ["kill", container.name],
    ["rm", "-f", container.name],
  ]) {
    try {
      const proc = Bun.spawn([container.engine, ...args], {
        env: container.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const timer = setTimeout(() => proc.kill(), 5000);
      await proc.exited;
      clearTimeout(timer);
    } catch {}
  }
}

export async function execute(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  deadline: number,
  container?: Container,
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
  let cleanup: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // Killing the engine client does not stop the container itself.
    if (container) cleanup = removeContainer(container);
  }, timeout);
  try {
    const [out, err, code] = await Promise.all([
      capped(proc.stdout, OUTPUT_CAP),
      capped(proc.stderr, OUTPUT_CAP),
      proc.exited,
    ]);
    if (timedOut) {
      await cleanup;
      throw Error("CHECK_TIMEOUT");
    }
    const truncated = out.truncated || err.truncated;
    return {
      exitCode: code,
      output:
        (out.text + "\n" + err.text).slice(0, OUTPUT_CAP) +
        (truncated ? "\n[output truncated]" : ""),
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

function checkArgs(argv: string[], repo: string, work: string): string[] {
  const args = ["-p", "no:cacheprovider", "--noconftest", "-c", `${work}/pytest.ini`, "--rootdir", work];
  let targets = 0;
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-p" && argv[i + 1] === "no:cacheprovider") { i++; continue; }
    if (["-q", "-s", "-v", "-x"].includes(arg)) { args.push(arg); continue; }
    if (arg.startsWith("-") || isAbsolute(arg) || arg.split(/[\\/]/).includes("..") || arg.includes("\\")) throw Error("CHECK_NOT_ALLOWED");
    args.push(`${repo}/${arg}`);
    targets++;
  }
  if (!targets) args.push(repo);
  return args;
}

export function makeRunner(
  allowUnisolated: boolean,
  engine = Bun.which("podman") || Bun.which("docker"),
): Runner {
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
      // Per-run scratch directory; its unique name also names the container.
      const work = mkdtempSync(join(tmpdir(), "devpilot-check-"));
      const container: Container = {
        engine: engine!,
        name: basename(work),
        env: engineEnv,
      };
      const bootstrap = resolve(import.meta.dir, "verification/check_bootstrap.py");
      writeFileSync(join(work, "pytest.ini"), "[pytest]\n");
      try {
        if (isolation === "unisolated")
          return await execute(
            ["python3", "-I", bootstrap, site, snapshot, ...checkArgs(argv, snapshot, work)],
            work,
            environment,
            deadline,
          );
        return await execute(
          [
          engine!,
          "run",
          "--rm",
          "--name",
          container.name,
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
          "--volume",
          `${work}:/check:rw`,
          "--volume",
          `${bootstrap}:/check_bootstrap.py:ro`,
          "--workdir",
          "/check",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          "--env",
          "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
          image,
          "python3", "-I", "/check_bootstrap.py", "", "/repo",
          ...checkArgs(argv, "/repo", "/check"),
        ],
        work,
        engineEnv,
        deadline,
        container,
      );
      } catch (error) {
        // --rm covers normal exits; make sure nothing outlives a failed run.
        if (isolation === "isolated") await removeContainer(container);
        throw error;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
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
