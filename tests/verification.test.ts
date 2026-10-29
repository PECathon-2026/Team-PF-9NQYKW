import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunner, suiteDigest } from "../src/runner";
import { startServer } from "../src/server";

const roots: string[] = [];
const apps: ReturnType<typeof startServer>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup(source: string, privateTest: string, privateConftest = "") {
  const root = mkdtempSync(join(tmpdir(), "devpilot-verify-test-"));
  roots.push(root);
  const candidate = join(root, "candidate"),
    suite = join(root, "private");
  mkdirSync(candidate);
  mkdirSync(suite);
  writeFileSync(join(candidate, "candidate.py"), source);
  writeFileSync(
    join(suite, "conftest.py"),
    `import os, sys\nsys.path.insert(0, os.environ["CANDIDATE_DIR"])\n${privateConftest}`,
  );
  writeFileSync(join(suite, "test_private.py"), privateTest);
  return {
    root,
    candidate,
    suite,
    config: {
      check: {
        id: "pytest",
        argv: [
          "python3",
          "-m",
          "pytest",
          "-q",
          "-s",
          "-p",
          "no:cacheprovider",
          "tests",
        ],
      },
      acceptance: { argv: ["python3", "-m", "pytest", "-q"] },
    },
  };
}
async function acceptance(f: ReturnType<typeof setup>) {
  return makeRunner(true).acceptance(
    f.candidate,
    f.config,
    { path: f.suite, digest: suiteDigest(f.suite) },
    Date.now() + 15000,
  );
}

test("Verifier, candidate worker, Sentinel and service use distinct processes and a scrubbed environment", async () => {
  const f = setup(
    'import os\ndef pid(): return os.getpid()\ndef has_secret(): return any(k.startswith("MINIMAX_") for k in os.environ)\n',
    "",
  );
  mkdirSync(join(f.candidate, "tests"));
  writeFileSync(
    join(f.candidate, "tests", "test_pid.py"),
    'import os\ndef test_sentinel_pid(): print("SENTINEL_PROCESS", os.getpid())\n',
  );
  const runner = makeRunner(true);
  const sentinel = await runner.check(
    f.candidate,
    f.config,
    Date.now() + 15000,
  );
  expect(sentinel.exitCode).toBe(0);
  const pid = Number(/SENTINEL_PROCESS (\d+)/.exec(sentinel.output)?.[1]);
  expect(pid).toBeGreaterThan(0);
  writeFileSync(
    join(f.suite, "test_private.py"),
    `import os\nfrom candidate import pid, has_secret\ndef test_process_boundary():\n    assert pid() != os.getpid()\n    assert pid() != ${pid}\n    assert pid() != ${process.pid}\n    assert not has_secret()\n`,
  );
  const old = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = crypto.randomUUID();
  try {
    const result = await acceptance(f);
    expect(result.passed).toBe(true);
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]!.passed).toBe(true);
  } finally {
    if (old === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = old;
  }
}, 20000);

test("candidate pytest settings and conftest do not run, and its copy is read-only", async () => {
  const f = setup(
    `def can_modify():\n    try:\n        with open(__file__, "a") as file: file.write("tamper")\n        return True\n    except PermissionError:\n        return False\n`,
    "from candidate import can_modify\ndef test_candidate_readonly():\n    assert not can_modify()\n",
  );
  const marker = join(f.root, "candidate-conftest-ran");
  writeFileSync(
    join(f.candidate, "conftest.py"),
    `open(${JSON.stringify(marker)}, "w").write("loaded")\ndef pytest_sessionfinish(session): session.exitstatus = 0\n`,
  );
  writeFileSync(
    join(f.candidate, "pytest.ini"),
    "[pytest]\naddopts = --collect-only\n",
  );
  const original = readFileSync(join(f.candidate, "candidate.py"), "utf8");
  const result = await acceptance(f);
  expect(result.passed).toBe(true);
  expect(result.criteria).toHaveLength(1);
  expect(() => readFileSync(marker)).toThrow();
  expect(readFileSync(join(f.candidate, "candidate.py"), "utf8")).toBe(
    original,
  );
  writeFileSync(
    join(f.suite, "test_private.py"),
    "from candidate import can_modify\ndef test_must_fail(): assert can_modify()\n",
  );
  const failing = await acceptance(f);
  expect(failing.passed).toBe(false);
  expect(failing.criteria[0]!.passed).toBe(false);
  expect(() => readFileSync(marker)).toThrow();
}, 20000);

test("candidate monkeypatches of pytest or junit cannot turn a failing assertion into a pass", async () => {
  const f = setup(
    `import pytest\npytest.fail = lambda *a, **k: None\nimport _pytest.junitxml as junit\njunit.LogXML.pytest_sessionfinish = lambda *a, **k: None\ndef was_patched(): return True\ndef value(): return 0\n`,
    "from candidate import value, was_patched\ndef test_worker_was_patched():\n    assert was_patched()\ndef test_actual_value():\n    assert value() == 42\n",
  );
  const result = await acceptance(f);
  expect(result.passed).toBe(false);
  expect(result.criteria).toHaveLength(2);
  expect(
    result.criteria.find((c) => c.id.endsWith("::test_worker_was_patched"))
      ?.passed,
  ).toBe(true);
  expect(
    result.criteria.find((c) => c.id.endsWith("::test_actual_value"))?.passed,
  ).toBe(false);
  expect(JSON.stringify(result)).not.toContain("assert value()");
  expect(JSON.stringify(result)).not.toContain("Traceback");
}, 20000);

test("early candidate process exit and missing collected test IDs fail closed", async () => {
  const exiting = setup(
    "import os\nos._exit(0)\ndef value(): return 42\n",
    "from candidate import value\ndef test_value(): assert value() == 42\n",
  );
  const exited = await acceptance(exiting);
  expect(exited.passed).toBe(false);
  expect(exited.criteria.every((c) => !c.passed)).toBe(true);
  const missing = setup(
    "def value(): return 42\n",
    "from candidate import value\ndef test_value(): assert value() == 42\n",
    `\ndef pytest_collection_modifyitems(config, items):\n    if not config.getoption('collectonly'):\n        items.clear()\n`,
  );
  const missingResult = await acceptance(missing);
  expect(missingResult.passed).toBe(false);
  expect(missingResult.criteria).toHaveLength(1);
  expect(missingResult.criteria[0]!.passed).toBe(false);
}, 20000);

test("private failures publish test IDs and status, never hidden source or tracebacks", async () => {
  const f = setup(
    "def value(): return 0\n",
    'from candidate import value\ndef test_hidden_case():\n    secret_source_marker = "DO_NOT_PUBLISH_PRIVATE_SOURCE"\n    assert value() == 42, secret_source_marker\n',
  );
  mkdirSync(join(f.candidate, "tests"));
  writeFileSync(
    join(f.candidate, "tests", "test_public.py"),
    "def test_public(): assert True\n",
  );
  const request = "Fix value";
  const msg = (value: unknown) => ({
    role: "assistant",
    content: JSON.stringify(value),
  });
  const script = {
    shogun: [
      msg({
        criteria: [{ id: "acceptance", description: request }],
        tasks: [{ id: "fix", title: request }],
      }),
    ],
    samurai: [msg({ done: true })],
    shadow_review: [msg({ findings: [] })],
    shadow_security: [msg({ findings: [] })],
  };
  const registry = {
    tiny: {
      path: f.candidate,
      requests: {
        [request]: {
          ...f.config,
          suite: f.suite,
          suite_id: "suite",
          suite_sha256: suiteDigest(f.suite),
          criteria: [{ id: "acceptance", description: request }],
          mock_script: script,
        },
      },
    },
  };
  const app = startServer({
    root: join(f.root, "runtime"),
    registry,
    runner: makeRunner(true),
    mock: true,
    port: 0,
  });
  apps.push(app);
  const response = await fetch(`http://127.0.0.1:${app.server.port}/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "tiny", request }),
  });
  const { mission_id } = (await response.json()) as any;
  const stop = Date.now() + 15000;
  while (
    Date.now() < stop &&
    !["ESCALATED", "AWAITING_APPROVAL"].includes(
      app.service.store.get(mission_id).state,
    )
  )
    await Bun.sleep(20);
  expect(app.service.store.get(mission_id).state).toBe("ESCALATED");
  const events = app.service.store.events(mission_id);
  const result = events.find(
    (e) => e.type === "test_result" && e.payload.suite_id === "suite",
  );
  expect(result?.payload.outcome).toBe("failed");
  expect(result?.payload.isolation).toBe("unisolated");
  expect(result?.payload.criteria[0]).toMatchObject({
    id: expect.any(String),
    passed: false,
  });
  expect(JSON.stringify(events)).not.toContain("DO_NOT_PUBLISH_PRIVATE_SOURCE");
  expect(JSON.stringify(events)).not.toContain("Traceback");
}, 20000);

test("missing JUnit and an unexpected nonzero pytest exit fail closed", async () => {
  const missingXml = setup(
    "def value(): return 42\n",
    "import os\ndef test_exit_before_xml(): os._exit(0)\n",
  );
  const missing = await acceptance(missingXml);
  expect(missing.passed).toBe(false);
  expect(missing.criteria).toHaveLength(1);
  expect(missing.criteria[0]!.passed).toBe(false);

  const unexpectedExit = setup(
    "def value(): return 42\n",
    "from candidate import value\ndef test_value(): assert value() == 42\n",
    "\ndef pytest_sessionfinish(session):\n    if not session.config.getoption('collectonly'):\n        session.exitstatus = 2\n",
  );
  const unexpected = await acceptance(unexpectedExit);
  expect(unexpected.passed).toBe(false);
  expect(unexpected.criteria).toHaveLength(1);
  expect(unexpected.criteria[0]!.passed).toBe(false);

  const malformedXml = setup(
    "def value(): return 42\n",
    "from candidate import value\ndef test_value(): assert value() == 42\n",
    "\nimport pytest\n@pytest.hookimpl(trylast=True)\ndef pytest_sessionfinish(session):\n    path = session.config.option.xmlpath\n    if path:\n        open(path, 'w').write('<broken')\n",
  );
  const malformed = await acceptance(malformedXml);
  expect(malformed.passed).toBe(false);
  expect(malformed.criteria).toHaveLength(1);
  expect(malformed.criteria[0]!.passed).toBe(false);
}, 20000);

test("a candidate that hangs cannot produce passing acceptance", async () => {
  const f = setup(
    "import time\ndef value():\n    time.sleep(10)\n    return 42\n",
    "from candidate import value\ndef test_value(): assert value() == 42\n",
  );
  await expect(
    makeRunner(true).acceptance(
      f.candidate,
      f.config,
      { path: f.suite, digest: suiteDigest(f.suite) },
      Date.now() + 1000,
    ),
  ).rejects.toThrow("CHECK_TIMEOUT");
}, 10000);

test("unisolated verification uses a network namespace when available", async () => {
  const unshare = Bun.which("unshare");
  const setpriv = Bun.which("setpriv");
  if (!unshare || !setpriv) return;
  const probe = Bun.spawnSync(
    [
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
      "true",
    ],
    {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" },
      stdout: "ignore",
      stderr: "ignore",
      timeout: 2000,
    },
  );
  if (probe.exitCode !== 0) return;
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("host"),
  });
  try {
    expect((await fetch(`http://127.0.0.1:${host.port}`)).status).toBe(200);
    const f = setup(
      `import socket\ndef reachable():\n    try:\n        conn = socket.create_connection(('127.0.0.1', ${host.port}), timeout=0.5)\n        conn.close()\n        return True\n    except OSError:\n        return False\n`,
      "from candidate import reachable\ndef test_offline(): assert not reachable()\n",
    );
    expect((await acceptance(f)).passed).toBe(true);
  } finally {
    host.stop(true);
  }
}, 20000);
