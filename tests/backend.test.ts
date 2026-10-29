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
import { Service, assessFinding } from "../src/service";
import { commandFor, readTool, editTool } from "../src/tools";
import { treeHash } from "../src/tree";
import type { Runner } from "../src/runner";
import { MockModel } from "../src/model";

const roots: string[] = [];
const apps: any[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const text = (v: any) => ({
  role: "assistant",
  content: JSON.stringify(v),
  usage: { prompt_tokens: 5, completion_tokens: 2 },
});
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
    text({
      findings: [
        {
          severity: "high",
          title: "Incorrect arithmetic",
          detail: "The candidate adds an extra unit.",
          in_scope: true,
          evidence: { path: "calc.py", line: 2 },
        },
      ],
    }),
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
  // Tests exercise approval mechanics with a trusted runner double.
  isolation: "isolated",
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
    const createdBody = (await created.json()) as any;
    const { mission_id } = createdBody;
    expect(createdBody).toEqual({ mission_id, id: mission_id });
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
    const baselineEvent = events.find(
      (e) => e.type === "test_result" && e.payload.phase === "baseline",
    )!;
    const planEvent = events.find((e) => e.type === "plan")!;
    expect(baselineEvent.id).toBeLessThan(planEvent.id);
    expect(baselineEvent.payload.outcome).toBe("failed");
    expect(planEvent.payload.reason_event_ids).toContain(baselineEvent.id);
    expect(planEvent.payload.tasks[0]).toMatchObject({
      id: "fix",
      role: "samurai",
      status: "pending",
    });
    const updates = events.filter((e) => e.type === "task_update");
    expect(updates.map((e) => e.payload.status)).toEqual([
      "in_progress",
      "blocked",
      "in_progress",
      "completed",
    ]);
    expect(
      updates.every((e) => e.task_id === "fix" && e.payload.task_id === "fix"),
    ).toBe(true);
    expect(
      events.every((e) =>
        e.type === "test_result"
          ? e.payload.isolation === "isolated"
          : !("isolation" in e.payload),
      ),
    ).toBe(true);
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
    const stale = events.find((e) => e.type === "stale")!;
    expect(stale.payload.old_revision).toBeString();
    expect(stale.payload.new_revision).toBeString();
    expect(stale.payload.affected_evidence_ids.length).toBeGreaterThan(0);
    expect(stale.payload.reason).toBe("edit");
    const sentBack = events.find(
      (e) => e.type === "finding" && e.payload.action === "sent_back",
    )!;
    expect(sentBack.payload).toMatchObject({
      finding_id: expect.any(String),
      severity: "high",
      blocking: true,
      action: "sent_back",
    });
    expect(
      events.filter((e) => e.type === "finding").map((e) => e.payload),
    ).toContainEqual(
      expect.objectContaining({
        finding_id: sentBack.payload.finding_id,
        action: "resolve",
      }),
    );
    const diff = events.filter((e) => e.type === "diff").at(-1)!;
    expect(diff.payload.text).toContain("+    return a + b");
    expect(diff.payload.text).toContain("-    return a - b");
    const artifact = await fetch(
      `${a.url}/missions/${mission_id}/artifacts/${diff.payload.artifact_id}`,
    );
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toBe(diff.payload.text);
    expect(
      (
        await fetch(
          `${a.url}/missions/not-this-mission/artifacts/${diff.payload.artifact_id}`,
        )
      ).status,
    ).toBe(404);
    const approval = events.find((e) => e.type === "approval_needed")!.payload;
    expect(approval).toMatchObject({
      approval_id: expect.any(String),
      evidence_ids: expect.any(Array),
      tree_hash: expect.any(String),
      decision: null,
    });
    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBeGreaterThan(0);
    let previousTurns = 0;
    for (const event of usageEvents) {
      expect(Object.keys(event.payload).sort()).toEqual([
        "budget",
        "mission_cap",
        "pass_turns",
        "per_agent",
        "review_pass",
        "total",
      ]);
      expect(event.payload.budget.shadow_security).toBe(12);
      expect([44, 60]).toContain(event.payload.mission_cap);
      expect(event.payload.review_pass.code_rev).toBe(event.code_rev);
      for (const role of ["shadow_review", "shadow_security", "verifier"])
        expect(event.payload.pass_turns[role]).toBe(
          event.payload.review_pass.turns[role],
        );
      expect(event.payload.total.turns).toBeGreaterThanOrEqual(previousTurns);
      previousTurns = event.payload.total.turns;
      const agents = Object.values(event.payload.per_agent) as any[];
      expect(
        agents.every(
          (agent) =>
            Object.keys(agent).sort().join(",") ===
            "input_tokens,output_tokens,turns",
        ),
      ).toBe(true);
      for (const key of ["turns", "input_tokens", "output_tokens"]) {
        expect(agents.reduce((sum, agent) => sum + agent[key], 0)).toBe(
          event.payload.total[key],
        );
      }
    }
    expect(
      usageEvents.some(
        (e) =>
          e.payload.per_agent.shogun?.input_tokens === 5 &&
          e.payload.per_agent.shogun?.output_tokens === 2,
      ),
    ).toBe(true);
    expect(
      usageEvents.some(
        (event) =>
          event.agent === "orchestrator" && event.payload.mission_cap === 60,
      ),
    ).toBe(true);
    expect(
      usageEvents.some(
        (event) =>
          event.agent === "shogun" && event.payload.pass_turns.shogun === 1,
      ),
    ).toBe(true);
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
    const done = replay.find((e) => e.type === "mission_done").payload;
    const resultApproval = replay.find(
      (e) => e.type === "approval_result",
    ).payload;
    expect(resultApproval).toMatchObject({
      approval_id: approval.approval_id,
      evidence_ids: approval.evidence_ids,
      tree_hash: approval.tree_hash,
      decision: true,
    });
    expect(done.status).toBe("COMPLETED");
    expect(done.active_elapsed_ms).toBe(approval.active_elapsed_ms);
    expect(done.wall_elapsed_ms).toBeGreaterThanOrEqual(
      done.active_elapsed_ms - 5,
    );
    expect(done.total.turns).toBe(m.turns);
    expect(done.total.input_tokens).toBeGreaterThan(0);
    expect(done.per_agent.shogun).toEqual({
      turns: 1,
      input_tokens: 5,
      output_tokens: 2,
    });
    expect(done.total).toEqual(usageEvents.at(-1)!.payload.total);
    expect(done.per_agent).toEqual(usageEvents.at(-1)!.payload.per_agent);
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
    ).toBe(409);
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
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: false,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: true,
        })
      ).status,
    ).toBe(409);
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
      missionTurnLimit: 20,
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
  const escalation = service.store
    .events(mission)
    .find((e) => e.type === "escalation")!;
  expect(escalation.payload.artifact_id).toMatch(/^debug_/);
  expect(
    readFileSync(
      join(
        f.root,
        "deadline-runtime",
        "artifacts",
        mission,
        `${escalation.payload.artifact_id}.txt`,
      ),
      "utf8",
    ),
  ).toContain("replies");
  expect(escalation.payload.question).toContain("deadline expired");
  expect(escalation.payload.relevant_event_ids.length).toBeGreaterThan(0);
  expect(
    escalation.payload.relevant_event_ids.every((id: number) =>
      service.store.events(mission).some((event) => event.id === id),
    ),
  ).toBe(true);
});

test("deadline debug artifacts redact replies and are available from the mission artifact endpoint", async () => {
  const f = fixture();
  const oldKey = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = "deadline-private-test-key";
  let calls = 0;
  const model = {
    async complete(
      _role: string,
      _messages: any[],
      _tools: any[],
      signal: AbortSignal,
    ) {
      if (++calls === 1)
        return {
          role: "assistant",
          content: "deadline-private-test-key",
          tool_calls: [
            {
              id: "read",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "calc.py" }),
              },
            },
          ],
        };
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Error("DEADLINE")), {
          once: true,
        }),
      );
      return {};
    },
  };
  const app = startServer({
    root: join(f.root, "deadline-artifact"),
    registry: f.registry,
    runner: {
      ...localRunner,
      async check() {
        return { exitCode: 1, output: "failed", duration: 0 };
      },
    },
    model,
    deadlineMs: 150,
    port: 0,
  });
  apps.push(app);
  try {
    const response = await post(
      `http://127.0.0.1:${app.server.port}/missions`,
      { repo: "tiny", request: f.request },
    );
    const { mission_id } = (await response.json()) as any;
    await waitFor(
      () => app.service.store.get(mission_id).state === "ESCALATED",
    );
    const events = app.service.store.events(mission_id);
    const escalation = events.find((event) => event.type === "escalation")!;
    const artifact = await fetch(
      `http://127.0.0.1:${app.server.port}/missions/${mission_id}/artifacts/${escalation.payload.artifact_id}`,
    );
    expect(artifact.status).toBe(200);
    const raw = await artifact.text();
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("deadline-private-test-key");
    expect(JSON.stringify(events)).not.toContain("deadline-private-test-key");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4096);
    expect(escalation.payload.active_elapsed_ms).toBeGreaterThan(0);
    expect(escalation.payload.wall_elapsed_ms).toBeGreaterThanOrEqual(
      escalation.payload.active_elapsed_ms - 5,
    );
  } finally {
    if (oldKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = oldKey;
  }
});

test("parallel missions get independent wall deadlines and active durations", async () => {
  const f = fixture();
  const starts: number[] = [];
  const model = {
    async complete(
      _role: string,
      _messages: any[],
      _tools: any[],
      signal: AbortSignal,
    ) {
      starts.push(Date.now());
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Error("DEADLINE")), {
          once: true,
        }),
      );
      return {};
    },
  };
  const service = new Service({
    root: join(f.root, "parallel-deadlines"),
    registry: f.registry,
    runner: {
      ...localRunner,
      async check() {
        return { exitCode: 1, output: "failed", duration: 0 };
      },
    },
    model,
    deadlineMs: 200,
    maxDeadlineMs: 500,
  });
  apps.push({ close: () => service.close() });
  const first = service.create("tiny", f.request);
  const second = service.create("tiny", f.request);
  expect(
    service.store.get(first).deadline - service.store.get(first).created,
  ).toBe(200);
  expect(
    service.store.get(second).deadline - service.store.get(second).created,
  ).toBe(200);
  await waitFor(
    () =>
      service.store.get(first).state === "ESCALATED" &&
      service.store.get(second).state === "ESCALATED",
  );
  expect(starts).toHaveLength(2);
  for (const mid of [first, second]) {
    const escalation = service.store
      .events(mid)
      .find((event) => event.type === "escalation")!;
    expect(escalation.payload.reason).toBe("DEADLINE");
    expect(escalation.payload.active_elapsed_ms).toBeGreaterThan(0);
    expect(escalation.payload.active_elapsed_ms).toBeLessThanOrEqual(
      escalation.payload.wall_elapsed_ms + 5,
    );
    expect(escalation.payload.artifact_id).toMatch(/^debug_/);
  }
});

test("approval pauses the agent deadline and an approved apply resumes with the remaining time", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.shadow_review = [text({ findings: [] })];
  script.shadow_security = [text({ findings: [] })];
  const runner: Runner = {
    isolation: "isolated",
    async check() {
      return { exitCode: 0, output: "passed", duration: 0 };
    },
    async acceptance() {
      return { passed: true, criteria: [{ id: "addition", passed: true }] };
    },
  };
  const app = startServer({
    root: join(f.root, "gate-deadline"),
    registry: f.registry,
    runner,
    mock: true,
    deadlineMs: 300,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(
    () => app.service.store.get(mission_id).state === "AWAITING_APPROVAL",
  );
  const gate = app.service.store
    .events(mission_id)
    .find((event) => event.type === "approval_needed")!;
  const originalDeadline = app.service.store.get(mission_id).deadline;
  expect(gate.payload.deadline_paused).toBe(true);
  expect(gate.payload.deadline_remaining_ms).toBeGreaterThan(0);
  await Bun.sleep(400);
  expect(Date.now()).toBeGreaterThan(originalDeadline);
  expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
  expect(
    app.service.store
      .events(mission_id)
      .some((event) => event.type === "escalation"),
  ).toBe(false);
  const projection = (await (
    await fetch(`http://127.0.0.1:${app.server.port}/missions/${mission_id}`)
  ).json()) as any;
  expect(projection.deadline_paused).toBe(true);
  expect(projection.deadline_remaining_ms).toBe(
    gate.payload.deadline_remaining_ms,
  );
  const approval = await post(
    `http://127.0.0.1:${app.server.port}/missions/${mission_id}/approve`,
    { approved: true },
  );
  expect(approval.status).toBe(202);
  await waitFor(() =>
    ["COMPLETED", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  expect(app.service.store.get(mission_id).state).toBe("COMPLETED");
  expect(app.service.store.get(mission_id).deadline).toBeGreaterThan(
    originalDeadline,
  );
  const done = app.service.store
    .events(mission_id)
    .find((event) => event.type === "mission_done")!;
  expect(done.payload.active_elapsed_ms).toBe(gate.payload.active_elapsed_ms);
});

test("an approved apply is still subject to the resumed agent deadline", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.shadow_review = [text({ findings: [] })];
  script.shadow_security = [text({ findings: [] })];
  const runner: Runner = {
    isolation: "isolated",
    async check() {
      return { exitCode: 0, output: "passed", duration: 0 };
    },
    async acceptance() {
      return { passed: true, criteria: [{ id: "addition", passed: true }] };
    },
  };
  const app = startServer({
    root: join(f.root, "resumed-deadline"),
    registry: f.registry,
    runner,
    mock: true,
    deadlineMs: 250,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(
    () => app.service.store.get(mission_id).state === "AWAITING_APPROVAL",
  );
  app.service.apply = () => {};
  await Bun.sleep(300);
  expect(
    (
      await post(
        `http://127.0.0.1:${app.server.port}/missions/${mission_id}/approve`,
        { approved: true },
      )
    ).status,
  ).toBe(202);
  await waitFor(() => app.service.store.get(mission_id).state === "ESCALATED");
  const escalation = app.service.store
    .events(mission_id)
    .find((event) => event.type === "escalation")!;
  expect(escalation.payload.reason).toBe("DEADLINE");
  expect(escalation.payload.artifact_id).toMatch(/^debug_/);
});

test("a mission can be rejected after waiting beyond its original deadline", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.shadow_review = [text({ findings: [] })];
  script.shadow_security = [text({ findings: [] })];
  const runner: Runner = {
    isolation: "isolated",
    async check() {
      return { exitCode: 0, output: "passed", duration: 0 };
    },
    async acceptance() {
      return { passed: true, criteria: [{ id: "addition", passed: true }] };
    },
  };
  const app = startServer({
    root: join(f.root, "late-rejection"),
    registry: f.registry,
    runner,
    mock: true,
    deadlineMs: 150,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(
    () => app.service.store.get(mission_id).state === "AWAITING_APPROVAL",
  );
  await Bun.sleep(200);
  expect(
    (
      await post(
        `http://127.0.0.1:${app.server.port}/missions/${mission_id}/approve`,
        { approved: false },
      )
    ).status,
  ).toBe(202);
  expect(app.service.store.get(mission_id).state).toBe("REJECTED");
});

test("fix cycles extend the live deadline up to the hard maximum and preserve cancellation", async () => {
  const f = fixture();
  let aborted = false;
  const model = {
    async complete(
      _role: string,
      _messages: any[],
      _tools: any[],
      signal: AbortSignal,
    ) {
      await new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Error("DEADLINE"));
          },
          { once: true },
        ),
      );
      return {};
    },
  };
  const service = new Service({
    root: join(f.root, "extended-deadline-runtime"),
    registry: f.registry,
    runner: {
      ...localRunner,
      async check() {
        return { exitCode: 1, output: "failed", duration: 0 };
      },
    },
    model,
    deadlineMs: 800,
    fixExtensionMs: 500,
    maxDeadlineMs: 1600,
  });
  apps.push({ close: () => service.close() });
  const mission = service.create("tiny", f.request);
  const started = service.store
    .events(mission)
    .find((event) => event.type === "mission_started")!.payload;
  expect(started.deadline_max - started.deadline).toBe(800);
  expect(started.fix_extension_ms).toBe(500);
  service.reserve(mission, "fixes");
  expect(service.store.get(mission).deadline).toBe(started.deadline + 500);
  service.reserve(mission, "fixes");
  expect(service.store.get(mission).deadline).toBe(started.deadline_max);
  service.reserve(mission, "fixes");
  expect(service.store.get(mission).deadline).toBe(started.deadline_max);
  expect(() => service.reserve(mission, "fixes")).toThrow("FIX_LIMIT");
  await Bun.sleep(900);
  expect(service.store.get(mission).state).not.toBe("ESCALATED");
  expect(aborted).toBe(false);
  await waitFor(() => service.store.get(mission).state === "ESCALATED", 2500);
  expect(aborted).toBe(true);
  expect(
    service.store.events(mission).find((event) => event.type === "escalation")!
      .payload.reason,
  ).toBe("DEADLINE");
});

test("deadline extension and hard maximum are configurable in seconds", () => {
  const f = fixture();
  const previousExtension = process.env.DEVPILOT_FIX_EXTENSION_SECONDS;
  const previousMaximum = process.env.DEVPILOT_MAX_MISSION_SECONDS;
  const previousBase = process.env.DEVPILOT_BASE_MISSION_SECONDS;
  try {
    delete process.env.DEVPILOT_FIX_EXTENSION_SECONDS;
    delete process.env.DEVPILOT_MAX_MISSION_SECONDS;
    delete process.env.DEVPILOT_BASE_MISSION_SECONDS;
    const defaults = new Service({
      root: join(f.root, "default-deadline"),
      registry: f.registry,
      runner: localRunner,
    });
    apps.push({ close: () => defaults.close() });
    expect(defaults.deadlineMs).toBe(240000);
    expect(defaults.maxDeadlineMs).toBe(420000);
    process.env.DEVPILOT_FIX_EXTENSION_SECONDS = "25";
    process.env.DEVPILOT_BASE_MISSION_SECONDS = "200";
    process.env.DEVPILOT_MAX_MISSION_SECONDS = "210";
    const service = new Service({
      root: join(f.root, "env-deadline"),
      registry: f.registry,
      runner: localRunner,
    });
    apps.push({ close: () => service.close() });
    expect(service.fixExtensionMs).toBe(25000);
    expect(service.deadlineMs).toBe(200000);
    expect(service.maxDeadlineMs).toBe(210000);
    process.env.DEVPILOT_MAX_MISSION_SECONDS = "100";
    expect(
      () =>
        new Service({
          root: join(f.root, "invalid-deadline"),
          registry: f.registry,
          runner: localRunner,
        }),
    ).toThrow("INVALID_DEADLINE_CONFIGURATION");
  } finally {
    if (previousExtension === undefined)
      delete process.env.DEVPILOT_FIX_EXTENSION_SECONDS;
    else process.env.DEVPILOT_FIX_EXTENSION_SECONDS = previousExtension;
    if (previousMaximum === undefined)
      delete process.env.DEVPILOT_MAX_MISSION_SECONDS;
    else process.env.DEVPILOT_MAX_MISSION_SECONDS = previousMaximum;
    if (previousBase === undefined)
      delete process.env.DEVPILOT_BASE_MISSION_SECONDS;
    else process.env.DEVPILOT_BASE_MISSION_SECONDS = previousBase;
  }
});

test("paired baseline retains the multi-agent base and links both projections", async () => {
  const a = setup();
  const multiResponse = await post(`${a.url}/missions`, {
    repo: "tiny",
    request: a.request,
  });
  const { mission_id: multiId } = (await multiResponse.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      a.service.store.get(multiId).state,
    ),
  );
  expect(a.service.store.get(multiId).state).toBe("AWAITING_APPROVAL");
  await post(`${a.url}/missions/${multiId}/approve`, { approved: true });
  await waitFor(() => a.service.store.get(multiId).state === "COMPLETED");
  const multi = a.service.store.get(multiId);
  expect(readFileSync(join(multi.base_ref, "calc.py"), "utf8")).toContain(
    "a + b",
  );
  const response = await post(`${a.url}/missions`, {
    repo: "tiny",
    request: a.request,
    mode: "baseline",
    paired_mission_id: multiId,
  });
  expect(response.status).toBe(202);
  const { mission_id: baselineId, id } = (await response.json()) as any;
  expect(id).toBe(baselineId);
  const baseline = a.service.store.get(baselineId);
  expect(baseline.base_hash).toBe(multi.base_hash);
  expect(
    readFileSync(
      join(a.root, "runtime", "missions", baselineId, "r0", "calc.py"),
      "utf8",
    ),
  ).toContain("a - b");
  expect(baseline.baseline_of).toBe(multiId);
  expect(baseline.paired_mission_id).toBe(multiId);
  const multiProjection = (await (
    await fetch(`${a.url}/missions/${multiId}`)
  ).json()) as any;
  const baselineProjection = (await (
    await fetch(`${a.url}/missions/${baselineId}`)
  ).json()) as any;
  expect(multiProjection.paired_mission_id).toBe(baselineId);
  expect(baselineProjection.baseline_of).toBe(multiId);
  expect(
    a.service.store.events(baselineId).find((e) => e.type === "mission_started")
      ?.payload,
  ).toMatchObject({ baseline_of: multiId, paired_mission_id: multiId });
  expect(
    a.service.store
      .events(multiId)
      .some((e) => e.payload.paired_mission_id === baselineId),
  ).toBe(true);
  expect(
    (
      await post(`${a.url}/missions`, {
        repo: "tiny",
        request: a.request,
        mode: "baseline",
        paired_mission_id: multiId,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(`${a.url}/missions`, {
        repo: "tiny",
        request: a.request,
        mode: "multi",
        paired_mission_id: multiId,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post(`${a.url}/missions`, {
        repo: "tiny",
        request: a.request,
        mode: "baseline",
        paired_mission_id: "missing",
      })
    ).status,
  ).toBe(409);
  const artifactId = a.service.store
    .events(multiId)
    .find((e) => e.type === "diff")!.payload.artifact_id;
  expect(
    (await fetch(`${a.url}/missions/${baselineId}/artifacts/${artifactId}`))
      .status,
  ).toBe(404);
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      a.service.store.get(baselineId).state,
    ),
  );
  expect(a.service.store.get(baselineId).state).toBe("AWAITING_APPROVAL");
  await post(`${a.url}/missions/${baselineId}/approve`, { approved: false });
  const done = a.service.store
    .events(baselineId)
    .find((e) => e.type === "mission_done")!.payload;
  expect(done).toMatchObject({
    status: "REJECTED",
    baseline_of: multiId,
    paired_mission_id: multiId,
  });
  expect(Object.keys(done.per_agent)).toEqual(["baseline"]);
}, 20000);

test("both reviewers receive the full changed file and diff before using tools", async () => {
  const f = fixture();
  const extra = "x".repeat(33000);
  writeFileSync(
    join(f.repo, "calc.py"),
    `def add(a, b):\n    return a - b\n#${extra}\n`,
  );
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  const inner = new MockModel(script);
  const captured: { role: string; context: any }[] = [];
  const model = {
    async complete(
      role: string,
      messages: any[],
      tools: any[],
      signal: AbortSignal,
    ) {
      if (role === "shadow_review" || role === "shadow_security") {
        const context = JSON.parse(
          messages.find((message) => message.role === "user").content,
        );
        captured.push({ role, context });
      }
      return inner.complete(role, messages, tools, signal);
    },
  };
  const app = startServer({
    root: join(f.root, "review-context"),
    registry: f.registry,
    runner: localRunner,
    model,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
  for (const role of ["shadow_review", "shadow_security"]) {
    const context = captured.find((entry) => entry.role === role)!.context;
    expect(context.diff).toContain("return a + b + 1");
    expect(context.changed_paths).toContain("calc.py");
    const file = context.changed_files.find(
      (item: any) => item.path === "calc.py",
    );
    expect(file.content).toContain(extra);
    expect(file.content.length).toBeGreaterThan(32000);
    expect(JSON.stringify(context)).not.toContain(f.suite);
  }
}, 20000);

test("Samurai can use more than 16 cumulative turns across three mock fix cycles", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  const steps = [
    ["return a - b", "return a + b + 3"],
    ["return a + b + 3", "return a + b + 2"],
    ["return a + b + 2", "return a + b + 1"],
    ["return a + b + 1", "return a + b"],
  ];
  script.samurai = steps.flatMap(([old_text, new_text], cycle) => [
    call("list_dir", { path: "." }, `list-${cycle}-1`),
    call("list_dir", { path: "." }, `list-${cycle}-2`),
    call("list_dir", { path: "." }, `list-${cycle}-3`),
    call("edit_file", { path: "calc.py", old_text, new_text }, `edit-${cycle}`),
    text({ done: true }),
  ]);
  script.shadow_review = Array.from({ length: 4 }, () =>
    text({ findings: [] }),
  );
  script.shadow_security = Array.from({ length: 4 }, () =>
    text({ findings: [] }),
  );
  const passes = (snapshot: string) =>
    readFileSync(join(snapshot, "calc.py"), "utf8").includes("return a + b\n");
  const runner: Runner = {
    isolation: "isolated",
    async check(snapshot) {
      return { exitCode: passes(snapshot) ? 0 : 1, output: "", duration: 0 };
    },
    async acceptance(snapshot) {
      const passed = passes(snapshot);
      return { passed, criteria: [{ id: "addition", passed }] };
    },
  };
  const app = startServer({
    root: join(f.root, "samurai-fixes"),
    registry: f.registry,
    runner,
    mock: true,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
  expect(app.service.store.get(mission_id).fixes).toBe(3);
  const usage = app.service.store.usage(mission_id);
  expect(usage.per_agent.samurai!.turns).toBe(20);
  const events = app.service.store.events(mission_id);
  expect(
    events
      .filter(
        (event) => event.type === "usage" && event.agent === "orchestrator",
      )
      .map((event) => event.payload.budget.samurai),
  ).toEqual([24, 32, 40]);
  expect(events.filter((event) => event.type === "diff")).toHaveLength(4);
  expect(events.some((event) => event.type === "approval_needed")).toBe(true);
}, 20000);

test("reviewers get a fresh per-revision budget after a repair and reach approval", async () => {
  const f = fixture();
  const script: { shadow_review: any[]; shadow_security: any[] } =
    Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.shadow_review = [
    call("read_file", { path: "calc.py" }, "review-pass-1-read"),
    call(
      "submit_result",
      {
        findings: [
          {
            severity: "high",
            title: "Incorrect arithmetic",
            detail: "Adds an extra unit.",
            in_scope: true,
            evidence: { path: "calc.py", line: 2 },
          },
        ],
      },
      "review-pass-1-submit",
    ),
    call("read_file", { path: "calc.py" }, "review-pass-2-read"),
    call("submit_result", { findings: [] }, "review-pass-2-submit"),
  ];
  script.shadow_security = [
    call("read_file", { path: "calc.py" }, "security-pass-1-read"),
    call("submit_result", { findings: [] }, "security-pass-1-submit"),
    call("read_file", { path: "calc.py" }, "security-pass-2-read"),
    call("submit_result", { findings: [] }, "security-pass-2-submit"),
  ];
  const app = startServer({
    root: join(f.root, "review-budget-runtime"),
    registry: f.registry,
    runner: localRunner,
    mock: true,
    port: 0,
    roleTurnLimits: { shadow_review: 2, shadow_security: 2 },
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
  expect(app.service.store.get(mission_id).fixes).toBe(1);
  const events = app.service.store.events(mission_id);
  const initialDeadline = events.find(
    (event) => event.type === "mission_started",
  )!.payload.deadline;
  expect(
    events.find(
      (event) =>
        event.type === "task_update" && event.payload.status === "blocked",
    )!.payload.deadline,
  ).toBe(initialDeadline + 60000);
  const revisions = events
    .filter((event) => event.type === "diff")
    .map((event) => event.code_rev);
  expect(revisions).toHaveLength(2);
  for (const role of ["shadow_review", "shadow_security"]) {
    const calls = events.filter(
      (event) => event.type === "tool_call" && event.agent === role,
    );
    expect(calls.map((event) => event.payload.tool)).toEqual([
      "read_file",
      "submit_result",
      "read_file",
      "submit_result",
    ]);
    expect(calls.map((event) => event.code_rev)).toEqual([
      revisions[0],
      revisions[0],
      revisions[1],
      revisions[1],
    ]);
    const snapshots = events.filter(
      (event) => event.type === "usage" && event.agent === role,
    );
    expect(
      snapshots
        .filter((event) => event.payload.review_pass.code_rev === revisions[0])
        .at(-1)!.payload.review_pass.turns[role],
    ).toBe(2);
    expect(
      snapshots.filter(
        (event) => event.payload.review_pass.code_rev === revisions[1],
      )[0]!.payload.review_pass.turns[role],
    ).toBe(1);
    expect(snapshots.at(-1)!.payload.per_agent[role].turns).toBe(4);
  }
  expect(events.some((event) => event.type === "approval_needed")).toBe(true);
}, 20000);

test("unscoped, unsupported, and already addressed reviewer findings are advisory", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.samurai = [
    call(
      "edit_file",
      { path: "calc.py", old_text: "return a - b", new_text: "return a + b" },
      "edit-scope",
    ),
    text({ done: true }),
  ];
  script.shadow_review = [
    text({
      findings: [
        {
          severity: "critical",
          title: "Hard link hardening",
          detail: "An unrelated hardening idea.",
          in_scope: false,
          evidence: { path: "calc.py", line: 2 },
        },
        {
          severity: "high",
          title: "Unsupported claim",
          detail: "No concrete evidence.",
          in_scope: true,
        },
        {
          severity: "high",
          title: "Invalid file evidence",
          detail: "File does not exist.",
          in_scope: true,
          evidence: { path: "missing.py", line: 2 },
        },
        {
          severity: "high",
          title: "Already resolved",
          detail: "Addressed.",
          in_scope: true,
          addressed: true,
          evidence: { path: "calc.py", line: 2 },
        },
      ],
    }),
  ];
  script.shadow_security = [text({ findings: [] })];
  const app = startServer({
    root: join(f.root, "scope-runtime"),
    registry: f.registry,
    runner: localRunner,
    mock: true,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
  const findings = app.service.store
    .events(mission_id)
    .filter((event) => event.type === "finding");
  expect(findings).toHaveLength(4);
  expect(
    findings.every(
      (event) =>
        !event.payload.blocking &&
        event.payload.severity === "low" &&
        event.payload.advisory_reason,
    ),
  ).toBe(true);
  expect(app.service.store.get(mission_id).fixes).toBe(0);
}, 20000);

test("a repeated normalized finding is advisory after a single send-back", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.shadow_review = [
    text({
      findings: [
        {
          severity: "high",
          title: "Incorrect arithmetic!",
          detail: "Adds one.",
          in_scope: true,
          evidence: { failing_case: "add(2, 3) returns 6 instead of 5" },
        },
      ],
    }),
    text({
      findings: [
        {
          severity: "high",
          title: "incorrect   arithmetic",
          detail: "Same claim again.",
          in_scope: true,
          evidence: { path: "calc.py", line: 2 },
        },
      ],
    }),
  ];
  script.shadow_security = [
    text({
      findings: [
        {
          severity: "high",
          title: "Already fixed",
          detail: "Fixed in the candidate.",
          in_scope: true,
          addressed: true,
          evidence: { path: "calc.py", line: 2 },
        },
      ],
    }),
    text({
      findings: [
        {
          severity: "high",
          title: "already FIXED!",
          detail: "Reported again.",
          in_scope: true,
          evidence: { path: "calc.py", line: 2 },
        },
      ],
    }),
  ];
  const app = startServer({
    root: join(f.root, "repeat-runtime"),
    registry: f.registry,
    runner: localRunner,
    mock: true,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
  const findings = app.service.store
    .events(mission_id)
    .filter((event) => event.type === "finding");
  expect(
    findings.filter((event) => event.payload.action === "sent_back"),
  ).toHaveLength(1);
  const advisory = findings.find(
    (event) =>
      event.payload.action === "open" &&
      event.payload.advisory_reason?.includes("repeated"),
  )!;
  expect(advisory.payload.blocking).toBe(false);
  expect(advisory.payload.severity).toBe("low");
  expect(advisory.payload.finding_id).toBe(
    findings.find((event) => event.payload.action === "sent_back")!.payload
      .finding_id,
  );
  const addressed = findings.filter((event) =>
    event.payload.title.toLowerCase().includes("already"),
  );
  expect(addressed).toHaveLength(2);
  expect(
    addressed.every(
      (event) =>
        !event.payload.blocking &&
        event.payload.advisory_reason.includes("addressed"),
    ),
  ).toBe(true);
  expect(app.service.store.get(mission_id).fixes).toBe(1);
}, 20000);

test("scanner findings keep their ID through repair and resolve from a rerun", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.samurai = [
    call(
      "edit_file",
      {
        path: "calc.py",
        old_text: "return a - b",
        new_text: "return a + b + 1  # eval(",
      },
      "scan-edit-1",
    ),
    text({ done: true }),
    call(
      "edit_file",
      {
        path: "calc.py",
        old_text: "return a + b + 1  # eval(",
        new_text: "return a + b",
      },
      "scan-edit-2",
    ),
    text({ done: true }),
  ];
  script.shadow_review = [text({ findings: [] }), text({ findings: [] })];
  const app = startServer({
    root: join(f.root, "scanner-runtime"),
    registry: f.registry,
    runner: localRunner,
    mock: true,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
  const events = app.service.store.events(mission_id);
  const opened = events.find(
    (e) => e.type === "finding" && e.verified && e.payload.action === "open",
  )!;
  expect(opened.payload).toMatchObject({
    severity: "low",
    blocking: false,
    action: "open",
  });
  expect(
    events.some(
      (e) =>
        e.type === "finding" &&
        e.payload.action === "sent_back" &&
        e.payload.finding_id === opened.payload.finding_id,
    ),
  ).toBe(false);
  const resolved = events.find(
    (e) =>
      e.type === "finding" &&
      e.payload.action === "resolve" &&
      e.payload.finding_id === opened.payload.finding_id,
  )!;
  expect(resolved.verified).toBe(true);
  expect(resolved.payload.evidence_event_ids.length).toBeGreaterThan(0);
  await post(
    `http://127.0.0.1:${app.server.port}/missions/${mission_id}/approve`,
    { approved: false },
  );
  expect(
    app.service.store.events(mission_id).find((e) => e.type === "mission_done")!
      .payload.unresolved_findings,
  ).toEqual([]);
}, 20000);

test("resumed replay presents older usage records as cumulative snapshots", async () => {
  const { Store } = await import("../src/store");
  const store = new Store(":memory:", "unisolated");
  try {
    store.db
      .query(
        "INSERT INTO missions(id,repo,request,state,base_hash,base_ref,current_rev,snapshot,mode,created,deadline) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "m_legacy",
        "tiny",
        "request",
        "COMPLETED",
        "hash",
        "base",
        "rev",
        "snapshot",
        "multi",
        0,
        1,
      );
    const first = store.event("m_legacy", "usage", "shogun", {
      model_turns: 1,
      tokens: { prompt: 0, completion: 0 },
      agent_totals: { model_turns: 1, tokens: { prompt: 0, completion: 0 } },
      totals: { model_turns: 1, tokens: { prompt: 0, completion: 0 } },
      isolation: "unisolated",
    });
    store.event("m_legacy", "usage", "samurai", {
      model_turns: 1,
      tokens: { prompt: 0, completion: 0 },
      agent_totals: { model_turns: 1, tokens: { prompt: 0, completion: 0 } },
      totals: { model_turns: 2, tokens: { prompt: 0, completion: 0 } },
      isolation: "unisolated",
    });
    const replay = store.events("m_legacy", first.id);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.payload).toEqual({
      per_agent: {
        shogun: { turns: 1, input_tokens: 0, output_tokens: 0 },
        samurai: { turns: 1, input_tokens: 0, output_tokens: 0 },
      },
      total: { turns: 2, input_tokens: 0, output_tokens: 0 },
    });
  } finally {
    store.close();
  }
});

test("each mission starts from the seed and applies only to its own target", async () => {
  const a = setup();
  const createMission = async () => {
    const response = await post(`${a.url}/missions`, {
      repo: "tiny",
      request: a.request,
    });
    expect(response.status).toBe(202);
    return ((await response.json()) as any).mission_id as string;
  };
  const firstId = await createMission();
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      a.service.store.get(firstId).state,
    ),
  );
  const first = a.service.store.get(firstId);
  expect(first.state).toBe("AWAITING_APPROVAL");
  expect(
    (await post(`${a.url}/missions/${firstId}/approve`, { approved: true }))
      .status,
  ).toBe(202);
  await waitFor(() => a.service.store.get(firstId).state === "COMPLETED");
  expect(readFileSync(join(first.base_ref, "calc.py"), "utf8")).toContain(
    "a + b",
  );
  expect(readFileSync(join(a.repo, "calc.py"), "utf8")).toContain("a - b");

  const secondId = await createMission();
  const second = a.service.store.get(secondId);
  expect(second.base_ref).not.toBe(first.base_ref);
  expect(second.base_hash).toBe(first.base_hash);
  expect(
    readFileSync(
      join(a.root, "runtime", "missions", secondId, "r0", "calc.py"),
      "utf8",
    ),
  ).toContain("a - b");
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      a.service.store.get(secondId).state,
    ),
  );
  expect(a.service.store.get(secondId).state).toBe("AWAITING_APPROVAL");
  expect(
    (await post(`${a.url}/missions/${secondId}/approve`, { approved: true }))
      .status,
  ).toBe(202);
  await waitFor(() => a.service.store.get(secondId).state === "COMPLETED");
  expect(readFileSync(join(second.base_ref, "calc.py"), "utf8")).toContain(
    "a + b",
  );
  expect(readFileSync(join(first.base_ref, "calc.py"), "utf8")).toContain(
    "a + b",
  );
  expect(readFileSync(join(a.repo, "calc.py"), "utf8")).toContain("a - b");
}, 20000);

test("a no-op or reverted candidate never reaches approval", async () => {
  const a = setup();
  const script = Object.values(a.registry.tiny.requests)[0]!.mock_script;
  const attempts = [
    [text({ done: true })],
    [
      call(
        "edit_file",
        { path: "calc.py", old_text: "return a - b", new_text: "return a + b" },
        "change",
      ),
      call(
        "edit_file",
        { path: "calc.py", old_text: "return a + b", new_text: "return a - b" },
        "revert",
      ),
      text({ done: true }),
    ],
  ];
  for (const actions of attempts) {
    script.samurai = actions;
    const response = await post(`${a.url}/missions`, {
      repo: "tiny",
      request: a.request,
    });
    const { mission_id } = (await response.json()) as any;
    await waitFor(() => a.service.store.get(mission_id).state === "ESCALATED");
    const events = a.service.store.events(mission_id);
    expect(
      events.some(
        (e) => e.type === "escalation" && e.payload.reason === "NO_CHANGES",
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "approval_needed")).toBe(false);
    expect(
      (
        await post(`${a.url}/missions/${mission_id}/approve`, {
          approved: true,
        })
      ).status,
    ).toBe(409);
  }
}, 20000);

test("configured browser origins receive CORS access and unknown origins are rejected", async () => {
  const previous = process.env.DEVPILOT_ALLOWED_ORIGINS;
  try {
    delete process.env.DEVPILOT_ALLOWED_ORIGINS;
    const a = setup();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      const preflight = await fetch(`${a.url}/missions`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
      const response = await fetch(`${a.url}/missions`, {
        method: "POST",
        headers: { Origin: origin, "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(
        (
          await fetch(`${a.url}/ws?mission=none`, {
            headers: { Origin: origin },
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await fetch(`${a.url}/missions`, {
          headers: { Origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${a.url}/ws?mission=none`, {
          headers: { Origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${a.url}/missions`, {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:5173",
            "Access-Control-Request-Method": "DELETE",
          },
        })
      ).status,
    ).toBe(403);

    process.env.DEVPILOT_ALLOWED_ORIGINS =
      "http://frontend.example:4173, http://localhost:9000";
    const custom = setup();
    const allowed = await fetch(`${custom.url}/missions`, {
      headers: { Origin: "http://frontend.example:4173" },
    });
    expect(allowed.status).toBe(404);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://frontend.example:4173",
    );
    expect(
      (
        await fetch(`${custom.url}/missions`, {
          headers: { Origin: "http://frontend.example:4173.evil" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${custom.url}/missions`, {
          headers: { Origin: "http://localhost:5173" },
        })
      ).status,
    ).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.DEVPILOT_ALLOWED_ORIGINS;
    else process.env.DEVPILOT_ALLOWED_ORIGINS = previous;
  }
});

describe("gate rules for critical findings", () => {
  const snapshot = () => {
    const root = mkdtempSync(join(tmpdir(), "devpilot-gate-"));
    roots.push(root);
    writeFileSync(join(root, "calc.py"), "def add(a, b):\n    return a + b\n");
    return root;
  };
  const critical = {
    severity: "critical",
    title: "Off by one",
    detail: "Adds one.",
    in_scope: true,
    evidence: { path: "calc.py", line: 2 },
  };

  test("a repeated critical stays blocking; a repeated high does not", () => {
    const root = snapshot();
    const c = assessFinding(critical, root, true, false);
    expect(c.blocking).toBe(true);
    expect(c.severity).toBe("critical");
    const h = assessFinding({ ...critical, severity: "high" }, root, true, false);
    expect(h.blocking).toBe(false);
    expect(h.advisory_reason).toContain("repeated");
  });

  test("addressed critical needs resolution evidence and a changed tree", () => {
    const root = snapshot();
    const bare = assessFinding({ ...critical, addressed: true }, root, false, false);
    expect(bare.blocking).toBe(true);
    expect(bare.unaccepted_resolution).toContain("resolution_evidence");
    const missing = assessFinding(
      { ...critical, addressed: true, resolution_evidence: { path: "nope.py", line: 1 } },
      root,
      false,
      false,
    );
    expect(missing.blocking).toBe(true);
    const sameTree = assessFinding(
      { ...critical, addressed: true, resolution_evidence: { path: "calc.py", line: 2 } },
      root,
      false,
      false,
      false,
    );
    expect(sameTree.blocking).toBe(true);
    expect(sameTree.unaccepted_resolution).toContain("not changed");
    const ok = assessFinding(
      { ...critical, addressed: true, resolution_evidence: { path: "calc.py", line: 2 } },
      root,
      false,
      false,
      true,
    );
    expect(ok.blocking).toBe(false);
    expect(ok.advisory_reason).toContain("addressed");
    expect(ok.resolution_evidence).toEqual({ path: "calc.py", line: 2 });
    // A previous addressed claim (e.g. by key) never voids a critical.
    expect(assessFinding(critical, root, false, true).blocking).toBe(true);
    // Non-critical findings keep the old addressed behaviour.
    expect(
      assessFinding({ ...critical, severity: "high", addressed: true }, root, false, false)
        .blocking,
    ).toBe(false);
  });

  const editChain = [
    ["return a - b", "return a + b + 1"],
    ["return a + b + 1", "return a + b"],
    ["return a + b", "return b + a"],
    ["return b + a", "return a + b"],
  ].flatMap(([old_text, new_text], i) => [
    call("edit_file", { path: "calc.py", old_text, new_text }, "gate-edit" + i),
    text({ done: true }),
  ]);
  const runMission = async (f: any, name: string) => {
    const app = startServer({
      root: join(f.root, name),
      registry: f.registry,
      runner: localRunner,
      mock: true,
      port: 0,
    });
    apps.push(app);
    const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
      repo: "tiny",
      request: f.request,
    });
    const { mission_id } = (await response.json()) as any;
    await waitFor(() =>
      ["AWAITING_APPROVAL", "ESCALATED"].includes(
        app.service.store.get(mission_id).state,
      ),
    );
    return { app, mission_id };
  };

  test("findings are keyed per reviewer; repeated, bare-addressed and dropped criticals keep blocking", async () => {
    const f = fixture();
    const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
    script.samurai = editChain;
    script.shadow_review = [
      text({ findings: [critical] }),
      text({ findings: [{ ...critical, title: "off-by-one!", detail: "Again." }] }),
      text({ findings: [{ ...critical, addressed: true, detail: "Fixed, trust me." }] }),
      text({ findings: [] }),
    ];
    script.shadow_security = [
      text({ findings: [{ ...critical, in_scope: false, detail: "Hardening." }] }),
      text({ findings: [{ ...critical, severity: "high", addressed: true }] }),
      text({ findings: [] }),
      text({ findings: [] }),
    ];
    const { app, mission_id } = await runMission(f, "gate-keep-runtime");
    const mission = app.service.store.get(mission_id);
    expect(mission.state).toBe("ESCALATED");
    expect(mission.fixes).toBe(3);
    expect(
      app.service.store.events(mission_id).find((e) => e.type === "escalation")!
        .payload.reason,
    ).toBe("FIX_LIMIT");
    const findings = app.service.store
      .events(mission_id)
      .filter((event) => event.type === "finding");
    const review = findings.filter((e) => e.agent === "shadow_review");
    const security = findings.filter((e) => e.agent === "shadow_security");
    const reviewIds = new Set(review.map((e) => e.payload.finding_id));
    expect(reviewIds.size).toBe(1);
    expect(security.length).toBeGreaterThan(0);
    for (const e of security) expect(reviewIds.has(e.payload.finding_id)).toBe(false);
    // Every shadow_review emission of the critical stays blocking.
    expect(review.every((e) => e.payload.blocking && e.payload.action === "open")).toBe(true);
    expect(review.some((e) => e.payload.unaccepted_resolution)).toBe(true);
    expect(review.some((e) => e.payload.action === "resolve")).toBe(false);
    const done = app.service.store
      .events(mission_id)
      .find((e) => e.type === "mission_done")!;
    expect(
      done.payload.unresolved_findings.some(
        (f: any) => reviewIds.has(f.finding_id) && f.blocking,
      ),
    ).toBe(true);
  }, 30000);

  test("a reviewer resolves its own critical with resolution evidence after a change", async () => {
    const f = fixture();
    const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
    script.samurai = editChain;
    script.shadow_review = [
      text({ findings: [critical] }),
      text({
        findings: [
          {
            ...critical,
            addressed: true,
            resolution_evidence: { path: "calc.py", line: 2 },
          },
        ],
      }),
    ];
    script.shadow_security = [text({ findings: [] }), text({ findings: [] })];
    const { app, mission_id } = await runMission(f, "gate-resolve-runtime");
    expect(app.service.store.get(mission_id).state).toBe("AWAITING_APPROVAL");
    expect(app.service.store.get(mission_id).fixes).toBe(1);
    const last = app.service.store
      .events(mission_id)
      .filter((e) => e.type === "finding" && e.agent === "shadow_review")
      .at(-1)!;
    expect(last.payload.blocking).toBe(false);
    expect(last.payload.resolution_evidence).toEqual({ path: "calc.py", line: 2 });
  }, 30000);
});

test("tool_call arguments are redacted for non-edit tools", async () => {
  const f = fixture();
  const script = Object.values(f.registry.tiny.requests)[0]!.mock_script;
  script.samurai = [
    call("search", { path: ".", query: "api_key=sk-livesecretvalue123" }, "redact-search"),
    ...script.samurai,
  ];
  const app = startServer({
    root: join(f.root, "redact-runtime"),
    registry: f.registry,
    runner: localRunner,
    mock: true,
    port: 0,
  });
  apps.push(app);
  const response = await post(`http://127.0.0.1:${app.server.port}/missions`, {
    repo: "tiny",
    request: f.request,
  });
  const { mission_id } = (await response.json()) as any;
  await waitFor(() =>
    ["AWAITING_APPROVAL", "ESCALATED"].includes(
      app.service.store.get(mission_id).state,
    ),
  );
  const event = app.service.store
    .events(mission_id)
    .find((e) => e.type === "tool_call" && e.payload.call_id === "redact-search")!;
  expect(event.payload.arguments.path).toBe(".");
  expect(JSON.stringify(event.payload)).not.toContain("livesecretvalue");
}, 20000);
