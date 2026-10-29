import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, makeRunner, OUTPUT_CAP, suiteDigest } from "../src/runner";
import { verifyCandidate } from "../src/verifier";
import { entries, isSecretName, treeHash } from "../src/tree";
import { classifyEdit, readTool } from "../src/tools";
import { redact } from "../src/redaction";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "devpilot-containers-"));
  roots.push(root);
  return root;
};
const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" };

/** A fake container engine that logs each invocation to `log`. */
function fakeEngine(root: string, name = "podman") {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "engine.log");
  const engine = join(bin, name);
  writeFileSync(
    engine,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  info) echo true ;;
  run) if [ -f "${root}/sleep" ]; then exec sleep 5; fi; echo ran ;;
esac
exit 0
`,
  );
  chmodSync(engine, 0o755);
  return { engine, log, bin, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("execute caps streamed output instead of buffering it all", async () => {
  const result = await execute(
    ["python3", "-c", "import sys\nfor _ in range(200): sys.stdout.write('x' * 50000)\nsys.stderr.write('e' * 50000)"],
    temp(),
    env,
    Date.now() + 20000,
  );
  expect(result.exitCode).toBe(0);
  expect(result.output.length).toBeLessThanOrEqual(OUTPUT_CAP + 32);
  expect(result.output).toEndWith("[output truncated]");
});

test("execute kills and removes the named container on timeout", async () => {
  const root = temp();
  const fake = fakeEngine(root);
  const started = Date.now();
  await expect(
    execute(["sleep", "5"], root, env, Date.now() + 500, {
      engine: fake.engine,
      name: "devpilot-check-abc123",
      env,
    }),
  ).rejects.toThrow("CHECK_TIMEOUT");
  expect(Date.now() - started).toBeLessThan(4000);
  expect(fake.calls()).toEqual([
    "kill devpilot-check-abc123",
    "rm -f devpilot-check-abc123",
  ]);
});

test("isolated check runs a per-run named container and removes it on timeout", async () => {
  const root = temp();
  const fake = fakeEngine(root);
  const previous = { image: process.env.DEVPILOT_CONTAINER_IMAGE };
  process.env.DEVPILOT_CONTAINER_IMAGE = "python@sha256:" + "a".repeat(64);
  try {
    const runner = makeRunner(false, fake.engine);
    expect(runner.isolation).toBe("isolated");
    const snapshot = join(root, "snap");
    mkdirSync(snapshot);
    writeFileSync(join(snapshot, "x.py"), "x = 1\n");
    const config = { check: { argv: ["python3", "-m", "pytest", "-q"] } };
    const ok = await runner.check(snapshot, config, Date.now() + 10000);
    expect(ok.output).toContain("ran");
    const first = fake.calls().find((line) => line.startsWith("run "))!;
    const name = first.match(/--name (devpilot-check-\S+)/)![1]!;
    // The name is the per-run scratch directory, removed after the run.
    expect(first).toContain(`/${name}:/check:rw`);
    expect(existsSync(join(tmpdir(), name))).toBe(false);

    writeFileSync(join(root, "sleep"), "");
    await expect(runner.check(snapshot, config, Date.now() + 800)).rejects.toThrow(
      "CHECK_TIMEOUT",
    );
    const runs = fake.calls().filter((line) => line.startsWith("run "));
    const second = runs[1]!.match(/--name (devpilot-check-\S+)/)![1]!;
    expect(second).not.toBe(name);
    expect(fake.calls()).toContain(`kill ${second}`);
    expect(fake.calls()).toContain(`rm -f ${second}`);
  } finally {
    if (previous.image === undefined) delete process.env.DEVPILOT_CONTAINER_IMAGE;
    else process.env.DEVPILOT_CONTAINER_IMAGE = previous.image;
  }
}, 20000);

test("verifier gives each harness run and the worker separate scratch mounts", async () => {
  const root = temp();
  const fake = fakeEngine(root, "docker");
  writeFileSync(join(root, "sleep"), "");
  const candidate = join(root, "candidate"),
    suite = join(root, "suite");
  mkdirSync(candidate);
  mkdirSync(suite);
  writeFileSync(join(candidate, "mod.py"), "x = 1\n");
  writeFileSync(join(suite, "test_a.py"), "def test_a():\n    pass\n");
  const runs: { argv: string[]; container?: any }[] = [];
  const mount = (argv: string[], target: string) =>
    argv.find((arg) => arg.endsWith(`:${target}:rw`))?.split(":")[0];
  const result = await verifyCandidate(
    candidate,
    { path: suite, digest: suiteDigest(suite) },
    Date.now() + 15000,
    {
      isolation: "isolated",
      engine: fake.engine,
      image: "img",
      engineEnv: env,
      environment: env,
      site: "",
      networkPrefix: [],
      suiteDigest,
      async execute(argv, _cwd, _env, _deadline, container) {
        runs.push({ argv, container });
        const results = mount(argv, "/results")!;
        writeFileSync(join(results, "collection.json"), JSON.stringify(["test_a::test_a"]));
        if (argv.includes("--junitxml"))
          writeFileSync(
            join(results, "report.xml"),
            '<testsuite><testcase classname="test_a" name="test_a"/></testsuite>',
          );
        return { exitCode: 0, output: "", duration: 1 };
      },
    },
  );
  expect(result.passed).toBe(true);
  expect(runs).toHaveLength(2);
  const scratches = runs.map((run) => mount(run.argv, "/scratch"));
  const worker = fake.calls().find((line) => line.startsWith("run "))!;
  const workerScratch = worker.match(/(\S+):\/scratch:rw/)![1];
  expect(new Set([...scratches, workerScratch]).size).toBe(3);
  for (const run of runs) {
    expect(run.container.engine).toBe(fake.engine);
    expect(run.argv).toContain(run.container.name);
  }
}, 20000);

test("credential-like files are skipped by tree walks and protected from edits", () => {
  const root = temp();
  writeFileSync(join(root, "app.py"), "x = 1\n");
  const clean = treeHash(root);
  mkdirSync(join(root, "deploy"));
  for (const name of [".env", ".env.local", ".envrc", "server.pem", "deploy/tls.key", "id_rsa", "id_ed25519.pub", ".netrc"])
    writeFileSync(join(root, name), "secret\n");
  const paths = entries(root).map((e) => e.path);
  expect(paths).toEqual(["app.py", "deploy"]);
  expect(treeHash(root)).not.toBe(clean); // only the new deploy/ directory
  rmSync(join(root, "deploy"), { recursive: true });
  expect(treeHash(root)).toBe(clean);
  for (const name of [".env.production", "key.pem", "id_rsa", "conf/.npmrc"])
    expect(classifyEdit(root, name).kind).toBe("protected");
  expect(isSecretName("keyboard.py")).toBe(false);
  expect(() => readTool(root, "read_file", { path: "id_rsa" })).toThrow("NOT_FOUND");
  expect(readTool(root, "list_dir", { path: "." }).entries).toEqual(["app.py"]);
});

test("redaction keeps token usage counters but hides secrets", () => {
  expect(
    redact({ input_tokens: 5, output_tokens: 2, api_key: "k", access_token: "t", query: "password=hunter2hunter2" }),
  ).toEqual({
    input_tokens: 5,
    output_tokens: 2,
    api_key: "[REDACTED]",
    access_token: "[REDACTED]",
    query: "password=[REDACTED]",
  });
});
