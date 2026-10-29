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
        "per_agent",
        "review_pass",
        "total",
      ]);
      expect(event.payload.budget.shadow_security).toBe(12);
      expect(event.payload.mission_cap).toBe(44);
      expect(event.payload.review_pass.code_rev).toBe(event.code_rev);
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
  expect(escalation.payload.question).toContain("deadline expired");
  expect(escalation.payload.relevant_event_ids.length).toBeGreaterThan(0);
  expect(
    escalation.payload.relevant_event_ids.every((id: number) =>
      service.store.events(mission).some((event) => event.id === id),
    ),
  ).toBe(true);
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
    severity: "high",
    blocking: true,
    action: "open",
  });
  expect(
    events.some(
      (e) =>
        e.type === "finding" &&
        e.payload.action === "sent_back" &&
        e.payload.finding_id === opened.payload.finding_id,
    ),
  ).toBe(true);
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
