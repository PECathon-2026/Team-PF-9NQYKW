import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";
import { Service } from "../src/service";
import { commandFor, readTool, editTool } from "../src/tools";
import { treeHash } from "../src/tree";
import type { Runner } from "../src/runner";

const roots: string[] = [];
const apps: any[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const text = (v: any) => ({ role: "assistant", content: JSON.stringify(v) });
const call = (name: string, args: any, n: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: n,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devpilot-test-"));
  roots.push(root);
  const repo = join(root, "source");
  mkdirSync(repo);
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(
    join(repo, "test_calc.py"),
    "from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
  );
  const suite = join(root, "private.json");
  writeFileSync(
    suite,
    JSON.stringify({
      criteria: [
        {
          id: "addition",
          description: "add two numbers",
          input: [-2, 5],
          expected: 3,
        },
      ],
    }),
  );
  const plan = [
    text({
      criteria: [{ id: "addition", description: "add two numbers" }],
      tasks: [{ id: "fix", title: "Fix addition" }],
    }),
  ];
  const editor = [
    call("read_file", { path: "calc.py" }, "read1"),
    call(
      "edit_file",
      {
        path: "calc.py",
        old_text: "return a - b",
        new_text: "return a + b + 1",
      },
      "edit1",
    ),
    text({ done: true }),
    call(
      "edit_file",
      {
        path: "calc.py",
        old_text: "return a + b + 1",
        new_text: "return a + b",
      },
      "edit2",
    ),
    text({ done: true }),
  ];
  const review = [
    call("read_file", { path: "calc.py" }, "review1"),
    text({ findings: [] }),
    text({ findings: [] }),
  ];
  const security = [text({ findings: [] }), text({ findings: [] })];
  const script = {
    shogun: plan,
    samurai: editor,
    shadow_review: review,
    shadow_security: security,
    baseline: [
      ...plan,
      ...editor.slice(0, 3),
      text({ findings: [] }),
      ...editor.slice(3),
      text({ findings: [] }),
    ],
  };
  const request = "Fix addition";
  const registry = {
    tiny: {
      path: repo,
      requests: {
        [request]: {
          suite,
          suite_id: "tiny-suite",
          check: { id: "pytest", argv: ["python3", "-m", "pytest", "-q"] },
          acceptance: { argv: [] },
          mock_script: script,
        },
      },
    },
  };
  return { root, repo, suite, request, registry };
}
const localRunner: Runner = {
  async check(snapshot, _cfg, _deadline) {
    const start = Date.now();
    const p = Bun.spawn(
      ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider"],
      {
        cwd: snapshot,
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { exitCode: code, output: out + err, duration: Date.now() - start };
  },
  async acceptance(snapshot, _cfg, suite, _deadline) {
    const criteria = [];
    for (const c of suite.criteria) {
      const p = Bun.spawn(
        [
          "python3",
          "-c",
          "import json,sys; from calc import add; print(json.dumps(add(*json.loads(sys.stdin.read()))))",
        ],
        {
          cwd: snapshot,
          env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      p.stdin.write(JSON.stringify(c.input));
      p.stdin.end();
      const [out, code] = await Promise.all([
        new Response(p.stdout).text(),
        p.exited,
      ]);
      let passed = false;
      try {
        passed = code === 0 && JSON.parse(out) === c.expected;
      } catch {}
      criteria.push({ id: c.id, passed });
    }
    return { passed: criteria.every((x) => x.passed), criteria };
  },
};
async function waitFor(fn: () => any, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const result = fn();
    if (result) return result;
    await Bun.sleep(20);
  }
  throw Error("timed out");
}
function setup() {
  const f = fixture();
  const app = startServer({
    root: join(f.root, "runtime"),
    registry: f.registry,
    runner: localRunner,
    mock: true,
    port: 0,
  });
  apps.push(app);
  return { ...f, ...app, url: `http://127.0.0.1:${app.server.port}` };
}
const post = (url: string, data: any) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

describe("backend", () => {
  test("API validation and WebSocket replay, feedback, approval and atomic apply", async () => {
    const a = setup();
    expect(
      (await post(a.url + "/missions", { repo: "missing", request: "x" }))
        .status,
    ).toBe(404);
    expect(
      (await post(a.url + "/missions", { repo: "tiny", request: "" })).status,
    ).toBe(400);
    const created = await post(a.url + "/missions", {
      repo: "tiny",
      request: a.request,
    });
    expect(created.status).toBe(202);
    const { mission_id } = (await created.json()) as any;
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: true,
        })
      ).status,
    ).toBe(409);
    await waitFor(
      () =>
        a.service.store.get(mission_id).state === "AWAITING_APPROVAL" ||
        a.service.store.get(mission_id).state === "ESCALATED",
    );
    const m = a.service.store.get(mission_id);
    expect(m.state).toBe("AWAITING_APPROVAL");
    expect(readFileSync(join(a.repo, "calc.py"), "utf8")).toContain("a - b");
    expect(readFileSync(join(m.base_ref, "calc.py"), "utf8")).toContain(
      "a - b",
    );
    const events = a.service.store.events(mission_id);
    expect(
      events.some(
        (e) => e.type === "test_result" && e.payload.outcome === "failed",
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "stale")).toBe(true);
    expect(
      events.some(
        (e) => e.type === "agent_msg" && e.payload.evidence_event_ids?.length,
      ),
    ).toBe(true);
    expect(m.fixes).toBe(1);
    const replay: any[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${a.server.port}/ws?mission=${mission_id}`,
    );
    ws.onmessage = (e) => replay.push(JSON.parse(String(e.data)));
    await waitFor(() => replay.length === events.length);
    expect(replay.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: true,
        })
      ).status,
    ).toBe(202);
    await waitFor(() => a.service.store.get(mission_id).state === "COMPLETED");
    await waitFor(() => replay.some((e) => e.type === "mission_done"));
    expect(readFileSync(join(m.base_ref, "calc.py"), "utf8")).toContain(
      "a + b",
    );
    expect(readFileSync(join(a.repo, "calc.py"), "utf8")).toContain("a - b");
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: true,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: false,
        })
      ).status,
    ).toBe(409);
    ws.close();
  }, 20000);
  test("baseline uses the same checks and reaches approval", async () => {
    const a = setup();
    const response = await post(a.url + "/missions", {
      repo: "tiny",
      request: a.request,
      mode: "baseline",
    });
    const { mission_id } = (await response.json()) as any;
    await waitFor(() =>
      ["AWAITING_APPROVAL", "ESCALATED"].includes(
        a.service.store.get(mission_id).state,
      ),
    );
    expect(a.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
    expect(
      a.service.store
        .events(mission_id)
        .some((e) => e.agent === "shogun" || e.agent === "samurai"),
    ).toBe(false);
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: false,
        })
      ).status,
    ).toBe(202);
    expect(a.service.store.get(mission_id).state).toBe("REJECTED");
  }, 20000);
  test("commands, paths and symlinks are confined", () => {
    const f = fixture();
    expect(commandFor("pytest")).toEqual(["python3", "-m", "pytest", "-q"]);
    expect(() => commandFor("rm -rf /")).toThrow();
    expect(() =>
      readTool(f.repo, "read_file", { path: "../private.json" }),
    ).toThrow();
    expect(() =>
      editTool(f.repo, { path: "/tmp/out", old_text: "", new_text: "x" }),
    ).toThrow();
    symlinkSync(f.suite, join(f.repo, "link"));
    expect(() => readTool(f.repo, "read_file", { path: "link" })).toThrow();
    expect(() => treeHash(f.repo)).toThrow();
    const dangling = join(f.repo, "dangling");
    const outside = join(f.root, "outside");
    symlinkSync(outside, dangling);
    expect(() =>
      editTool(f.repo, { path: "dangling", old_text: "", new_text: "bad" }),
    ).toThrow();
  });
  test("limits and repeated tool failures escalate", async () => {
    const f = fixture();
    const service = new Service({
      root: join(f.root, "runtime"),
      registry: f.registry,
      runner: localRunner,
      mock: true,
    });
    apps.push({ close: () => service.close() });
    const mid = service.create("tiny", f.request);
    for (let i = 0; i < 20; i++) service.reserve(mid, "turns");
    expect(() => service.reserve(mid, "turns")).toThrow("TURN_LIMIT");
    for (let i = 0; i < 3; i++) service.reserve(mid, "fixes");
    expect(() => service.reserve(mid, "fixes")).toThrow("FIX_LIMIT");
    await service.tool(mid, "samurai", "read_file", { path: "../bad" }, "bad1");
    await service.tool(mid, "samurai", "read_file", { path: "../bad" }, "bad2");
    expect(service.store.get(mid).state).toBe("ESCALATED");
    expect(
      service.store
        .events(mid)
        .some(
          (e) =>
            e.type === "escalation" &&
            e.payload.reason === "REPEATED_TOOL_FAILURE",
        ),
    ).toBe(true);
  });
  test("changed base blocks an approved candidate", async () => {
    const a = setup();
    const created = await post(a.url + "/missions", {
      repo: "tiny",
      request: a.request,
    });
    const { mission_id } = (await created.json()) as any;
    await waitFor(() =>
      ["AWAITING_APPROVAL", "ESCALATED"].includes(
        a.service.store.get(mission_id).state,
      ),
    );
    const m = a.service.store.get(mission_id);
    expect(m.state).toBe("AWAITING_APPROVAL");
    writeFileSync(join(m.base_ref, "changed.txt"), "external change");
    await post(`${a.url}/missions/${mission_id}/approve`, { approved: true });
    await waitFor(() => a.service.store.get(mission_id).state === "ESCALATED");
    expect(
      a.service.store
        .events(mission_id)
        .some(
          (e) => e.type === "escalation" && e.payload.reason === "BASE_CHANGED",
        ),
    ).toBe(true);
  }, 20000);
});

test("a mission deadline cancels a pending model call and escalates", async () => {
  const f = fixture();
  const model = {
    async complete(
      _role: string,
      _messages: any[],
      _tools: any[],
      signal: AbortSignal,
    ) {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Error("DEADLINE")), {
          once: true,
        });
      });
      return {};
    },
  };
  const service = new Service({
    root: join(f.root, "deadline-runtime"),
    registry: f.registry,
    runner: localRunner,
    model,
    deadlineMs: 30,
  });
  apps.push({ close: () => service.close() });
  const mission = service.create("tiny", f.request);
  await waitFor(() => service.store.get(mission).state === "ESCALATED");
  expect(
    service.store
      .events(mission)
      .some((e) => e.type === "escalation" && e.payload.reason === "DEADLINE"),
  ).toBe(true);
});
