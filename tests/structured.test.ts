import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../src/service";
import { turnBudgets } from "../src/budgets";
import { startServer } from "../src/server";
import {
  extractObject,
  PLAN_ROLES,
  submitPlanTool,
  validateReply,
} from "../src/structured";
import { readTool, editTool } from "../src/tools";
import { copyTree, treeHash } from "../src/tree";
import type { Model } from "../src/model";
import type { Runner } from "../src/runner";

const resources: (() => void)[] = [];
afterEach(() => {
  for (const dispose of resources.splice(0).reverse()) dispose();
});
const runner: Runner = {
  isolation: "isolated",
  async check() {
    return { exitCode: 1, output: "baseline failed", duration: 1 };
  },
  async acceptance() {
    return { passed: true, criteria: [{ id: "criterion", passed: true }] };
  },
};
const goodPlan = {
  criteria: [{ id: "criterion", description: "registered criterion" }],
  tasks: [{ id: "fix", title: "Fix defect", role: "samurai" }],
};
function environment() {
  const root = mkdtempSync(join(tmpdir(), "devpilot-structured-"));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "main.py"), "value = 1\n");
  const suite = join(root, "suite.json");
  writeFileSync(
    suite,
    JSON.stringify({
      criteria: [
        {
          id: "criterion",
          description: "registered criterion",
          input: 0,
          expected: 0,
        },
      ],
    }),
  );
  const request = "Repair";
  const registry = {
    tiny: {
      path: source,
      requests: {
        [request]: {
          suite,
          suite_id: "suite",
          check: { id: "pytest", argv: ["python3", "-m", "pytest"] },
          acceptance: { argv: [] },
        },
      },
    },
  };
  return { root, source, suite, request, registry };
}
function manual() {
  const env = environment();
  const service = new Service({
    root: join(env.root, "runtime"),
    registry: env.registry,
    runner,
  });
  resources.push(() => service.close());
  const now = Date.now();
  service.store.db
    .query(
      "INSERT INTO missions(id,repo,request,state,base_hash,base_ref,current_rev,snapshot,mode,created,deadline) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "manual",
      "tiny",
      env.request,
      "PLANNING",
      "hash",
      env.source,
      "r0:sha256:hash",
      env.source,
      "multi",
      now,
      now + 150000,
    );
  return { ...env, service };
}
function scripted(replies: any[]) {
  const inputs: any[] = [];
  let index = 0;
  const model: Model = {
    async complete(role, messages, tools) {
      inputs.push({
        role,
        messages: structuredClone(messages),
        tools: structuredClone(tools),
      });
      if (index >= replies.length) throw Error("SCRIPT_EXHAUSTED");
      return structuredClone(replies[index++]);
    },
  };
  return { model, inputs };
}
const reply = (content: string) => ({ role: "assistant", content });
const submit = (args: any) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "submit",
      type: "function",
      function: { name: "submit_plan", arguments: JSON.stringify(args) },
    },
  ],
});
async function waitFor(fn: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(10);
  }
  throw Error("timed out");
}

test("extracts the first valid object from thinking, fences and prose with nested braces and escapes", () => {
  const result = extractObject(
    '<think>{"wrong":true}</think>Here is the answer:\n```json\n{"text":"brace } and quote \\\" inside", "nested":{"n":1}}\n```\nTrailing text',
  );
  expect(result).toEqual({
    text: 'brace } and quote " inside',
    nested: { n: 1 },
  });
  expect(
    extractObject('invalid { not-json } then {"ok":true} and {"later":1}'),
  ).toEqual({ ok: true });
  expect(extractObject('prefix {unclosed then {"ok":2}')).toEqual({ ok: 2 });
  expect(extractObject('<think>unfinished {"private":1}')).toBeNull();
  expect(
    extractObject([{ type: "text", text: '```json\n{"done":true}\n```' }]),
  ).toEqual({ done: true });
});

test("schema checks give specific plan, editor, and review errors", () => {
  expect(
    validateReply("plan", { criteria: goodPlan.criteria }, [
      { id: "criterion" },
    ]),
  ).toContain("tasks");
  expect(
    validateReply(
      "plan",
      { ...goodPlan, criteria: [{ id: "wrong", description: "x" }] },
      [{ id: "criterion" }],
    ),
  ).toContain("registered IDs");
  expect(validateReply("edit", { done: false })).toContain("done");
  expect(
    validateReply("review", {
      findings: [{ severity: "unknown", title: "x", detail: "y" }],
    }),
  ).toContain("severity");
  expect(validateReply("review", { blocked: true })).toContain("question");
});

test("each agent gets exactly one schema-specific repair and can return fenced JSON", async () => {
  const cases = [
    {
      role: "shogun",
      phase: "plan",
      bad: '{"criteria":[{"id":"criterion","description":"registered criterion"}]}',
      good: goodPlan,
      issue: "tasks",
    },
    {
      role: "samurai",
      phase: "edit",
      bad: '{"done":false}',
      good: { done: true },
      issue: "done",
    },
    {
      role: "shadow_review",
      phase: "review",
      bad: '{"findings":[{"severity":"oops","title":"x","detail":"y"}]}',
      good: { findings: [] },
      issue: "severity",
    },
    {
      role: "shadow_security",
      phase: "review",
      bad: '{"findings":"none"}',
      good: { findings: [] },
      issue: "findings",
    },
    {
      role: "baseline",
      phase: "edit",
      bad: "not JSON",
      good: { done: true },
      issue: "No valid JSON object",
    },
  ];
  for (const item of cases) {
    const h = manual();
    const fake = scripted([
      reply(item.bad),
      reply(
        `<think>{"noise":true}</think>\n\`\`\`json\n${JSON.stringify(item.good)}\n\`\`\``,
      ),
    ]);
    const result = await h.service.session(
      "manual",
      item.role,
      { phase: item.phase, criteria: [{ id: "criterion" }] },
      fake.model,
    );
    expect(result).toEqual(item.good);
    expect(fake.inputs).toHaveLength(2);
    expect(fake.inputs[1].messages.at(-1).content).toContain(item.issue);
    const rejected = h.service.store
      .events("manual")
      .filter((e) => e.type === "agent_msg" && e.payload.artifact_id);
    expect(rejected).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(
          join(
            h.root,
            "runtime",
            "artifacts",
            "manual",
            `${rejected[0]!.payload.artifact_id}.txt`,
          ),
          "utf8",
        ),
      ).content,
    ).toBe(item.bad);
  }
});

test("submit_plan accepts a validated tool call and repairs an invalid tool submission once", async () => {
  const h = manual();
  const fake = scripted([
    submit({
      criteria: goodPlan.criteria,
      tasks: goodPlan.tasks,
      unexpected: "bad",
    }),
    submit(goodPlan),
  ]);
  const result = await h.service.session(
    "manual",
    "shogun",
    { phase: "plan", criteria: [{ id: "criterion" }] },
    fake.model,
  );
  expect(result).toEqual(goodPlan);
  expect(fake.inputs).toHaveLength(2);
  expect(
    fake.inputs[0].tools.some(
      (tool: any) => tool.function.name === "submit_plan",
    ),
  ).toBe(true);
  expect(fake.inputs[1].messages.at(-1).content).toContain("accepts only");
  const events = h.service.store.events("manual");
  expect(
    events.filter(
      (e) =>
        e.type === "tool_result" &&
        e.payload.error?.code === "INVALID_STRUCTURED_REPLY",
    ),
  ).toHaveLength(1);
  expect(
    events.filter(
      (e) => e.type === "tool_result" && e.payload.data?.status === "accepted",
    ),
  ).toHaveLength(1);
  const calls = events.filter(
    (e) => e.type === "tool_call" && e.payload.tool === "submit_plan",
  );
  expect(calls[0]!.payload.arguments.criteria).toEqual(goodPlan.criteria);
  expect(calls[0]!.payload.arguments.unexpected).toBe("bad");
  expect(calls[1]!.payload.arguments).toEqual(goodPlan);
});

test("root and normalized paths search correctly without weakening confinement", () => {
  const h = environment();
  mkdirSync(join(h.source, "nested"));
  writeFileSync(join(h.source, "nested", "match.py"), "needle\n");
  for (const path of ["", ".", "./", "././"])
    expect(
      readTool(h.source, "search", { path, query: "needle" }).matches.map(
        (m: any) => m.path,
      ),
    ).toEqual(["nested/match.py"]);
  for (const path of ["nested", "./nested/", "nested/."])
    expect(
      readTool(h.source, "search", { path, query: "needle" }).matches[0].path,
    ).toBe("nested/match.py");
  expect(
    readTool(h.source, "search", { path: "./nested/match.py", query: "needle" })
      .matches,
  ).toHaveLength(1);
  expect(() =>
    readTool(h.source, "search", { path: "nested/../", query: "needle" }),
  ).toThrow();
  expect(
    editTool(h.source, {
      path: "./nested/./match.py",
      old_text: "needle",
      new_text: "found",
    }).path,
  ).toBe("nested/match.py");
});

test("exhausted repair escalates with evidence and redacted local artifacts, without leaking replies", async () => {
  const h = environment();
  const previousKey = process.env.MINIMAX_API_KEY,
    previousFallback = process.env.MINIMAX_TOKEN_PLAN_KEY;
  const fakeKey = "unit-test-secret-alpha-93841",
    fakeFallback = "unit-test-secret-beta-63839";
  process.env.MINIMAX_API_KEY = fakeKey;
  process.env.MINIMAX_TOKEN_PLAN_KEY = fakeFallback;
  try {
    const fake = scripted([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "main.py" }),
            },
          },
        ],
      },
      reply(
        `RAW_PRIVATE_MARKER ${fakeKey} ${fakeFallback} api_key="generic-private-value" ` +
          "x".repeat(9000),
      ),
      reply(
        JSON.stringify({
          criteria: [{ id: "criterion", description: "registered criterion" }],
        }),
      ),
    ]);
    const app = startServer({
      root: join(h.root, "runtime"),
      registry: h.registry,
      runner,
      model: fake.model,
      port: 0,
    });
    resources.push(() => app.close());
    const response = await fetch(
      `http://127.0.0.1:${app.server.port}/missions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "tiny", request: h.request }),
      },
    );
    const { mission_id } = (await response.json()) as any;
    await waitFor(
      () => app.service.store.get(mission_id).state === "ESCALATED",
    );
    expect(fake.inputs).toHaveLength(3);
    const events = app.service.store.events(mission_id);
    const escalation = events.find((e) => e.type === "escalation")!;
    const rejected = events.filter(
      (e) => e.type === "agent_msg" && e.payload.artifact_id,
    );
    const toolResult = events.find(
      (e) => e.type === "tool_result" && e.agent === "shogun",
    )!;
    expect(escalation.payload.reason).toBe("MODEL_RESPONSE_INVALID");
    expect(escalation.payload.question).toContain("shogun");
    expect(escalation.payload.question).toContain("tasks");
    expect(rejected).toHaveLength(2);
    expect(escalation.payload.relevant_event_ids).toContain(toolResult.id);
    for (const event of rejected) {
      expect(escalation.payload.relevant_event_ids).toContain(event.id);
      const path = join(
        h.root,
        "runtime",
        "artifacts",
        mission_id,
        `${event.payload.artifact_id}.txt`,
      );
      const artifact = readFileSync(path, "utf8");
      expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(4096);
      expect(artifact).not.toContain(fakeKey);
      expect(artifact).not.toContain(fakeFallback);
      expect(artifact).not.toContain("generic-private-value");
      expect(statSync(path).mode & 0o077).toBe(0);
      const fetched = await fetch(
        `http://127.0.0.1:${app.server.port}/missions/${mission_id}/artifacts/${event.payload.artifact_id}`,
      );
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe(artifact);
      expect(
        (
          await fetch(
            `http://127.0.0.1:${app.server.port}/missions/other/artifacts/${event.payload.artifact_id}`,
          )
        ).status,
      ).toBe(404);
    }
    expect(JSON.stringify(events)).not.toContain("RAW_PRIVATE_MARKER");
    expect(JSON.stringify(events)).not.toContain(fakeKey);
    expect(JSON.stringify(events)).not.toContain(fakeFallback);
  } finally {
    if (previousKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = previousKey;
    if (previousFallback === undefined)
      delete process.env.MINIMAX_TOKEN_PLAN_KEY;
    else process.env.MINIMAX_TOKEN_PLAN_KEY = previousFallback;
  }
});

test("malformed provider messages and tool calls are omitted from repair history", async () => {
  for (const invalid of [
    { role: "invalid", content: "bad envelope" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "broken", type: "function" }],
    },
  ]) {
    const h = manual();
    const fake = scripted([invalid, reply('{"done":true}')]);
    const result = await h.service.session(
      "manual",
      "samurai",
      { phase: "edit" },
      fake.model,
    );
    expect(result).toEqual({ done: true });
    expect(fake.inputs).toHaveLength(2);
    expect(
      fake.inputs[1].messages.every(
        (m: any) => m.role !== "invalid" && !m.tool_calls,
      ),
    ).toBe(true);
  }
});

test("editor and reviewer failures exhaust a single repair with cited rejection events", async () => {
  for (const [role, phase] of [
    ["samurai", "edit"],
    ["shadow_review", "review"],
    ["shadow_security", "review"],
    ["baseline", "edit"],
  ] as const) {
    const h = manual();
    const fake = scripted([reply("bad first"), reply("bad again")]);
    let error: any;
    try {
      await h.service.session("manual", role, { phase }, fake.model);
    } catch (e) {
      error = e;
    }
    expect(error?.message).toBe("MODEL_RESPONSE_INVALID");
    expect(fake.inputs).toHaveLength(2);
    const rejected = h.service.store
      .events("manual")
      .filter((e) => e.type === "agent_msg" && e.payload.artifact_id);
    expect(rejected).toHaveLength(2);
    expect(error.eventIds).toEqual(rejected.map((e) => e.id));
  }
});

test("tool continuation preserves the complete assistant response including reasoning", async () => {
  const h = manual();
  const first = {
    role: "assistant",
    content: null,
    reasoning_content: "kept-for-provider-only",
    tool_calls: [
      {
        id: "inspect",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "main.py" }),
        },
      },
    ],
  };
  const fake = scripted([first, reply(JSON.stringify(goodPlan))]);
  await h.service.session(
    "manual",
    "shogun",
    { phase: "plan", criteria: [{ id: "criterion" }] },
    fake.model,
  );
  const previous = fake.inputs[1].messages.find(
    (message: any) => message.role === "assistant" && message.tool_calls,
  );
  expect(previous).toEqual(first);
  expect(JSON.stringify(h.service.store.events("manual"))).not.toContain(
    "kept-for-provider-only",
  );
});

test("an adapter reporting a malformed envelope receives one repair attempt", async () => {
  const h = manual();
  let calls = 0;
  const model: Model = {
    async complete() {
      calls++;
      if (calls === 1) throw Error("MODEL_RESPONSE_INVALID");
      return reply('{"done":true}');
    },
  };
  expect(
    await h.service.session("manual", "samurai", { phase: "edit" }, model),
  ).toEqual({ done: true });
  expect(calls).toBe(2);
  expect(
    h.service.store
      .events("manual")
      .filter((e) => e.type === "agent_msg" && e.payload.artifact_id),
  ).toHaveLength(1);
});

test("plan tool schema and repair feedback list only supported roles", async () => {
  const roleSchema =
    submitPlanTool.function.parameters.properties.tasks.items.properties.role;
  expect(roleSchema.enum).toEqual([
    "shogun",
    "samurai",
    "sentinel",
    "verifier",
    "shadow_review",
    "shadow_security",
  ]);
  const invalid = {
    ...goodPlan,
    tasks: [{ id: "fix", title: "Fix defect", role: "implementer" }],
  };
  const issue = validateReply("plan", invalid, [{ id: "criterion" }])!;
  for (const role of PLAN_ROLES) expect(issue).toContain(role);
  expect(issue).toContain("samurai");
  const h = manual(),
    fake = scripted([submit(invalid), submit(goodPlan)]);
  expect(
    await h.service.session(
      "manual",
      "shogun",
      { phase: "plan", criteria: [{ id: "criterion" }] },
      fake.model,
    ),
  ).toEqual(goodPlan);
  const repair = fake.inputs[1].messages.at(-1).content;
  for (const role of PLAN_ROLES) expect(repair).toContain(role);
  expect(repair).toContain("implementer or editor");
});

test("planner tool-call arguments are visible but secrets are redacted", async () => {
  const h = manual(),
    previous = process.env.MINIMAX_API_KEY,
    fakeKey = "fake-unit-secret-91392";
  process.env.MINIMAX_API_KEY = fakeKey;
  try {
    const invalid = { ...goodPlan, extra: `api_key=${fakeKey}` };
    const fake = scripted([submit(invalid), submit(goodPlan)]);
    await h.service.session(
      "manual",
      "shogun",
      { phase: "plan", criteria: [{ id: "criterion" }] },
      fake.model,
    );
    const calls = h.service.store
      .events("manual")
      .filter(
        (e) => e.type === "tool_call" && e.payload.tool === "submit_plan",
      );
    expect(calls[0]!.payload.arguments.criteria).toEqual(goodPlan.criteria);
    expect(calls[0]!.payload.arguments.extra).toContain("[REDACTED]");
    expect(JSON.stringify(calls)).not.toContain(fakeKey);
    expect(calls[1]!.payload.arguments).toEqual(goodPlan);
  } finally {
    if (previous === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = previous;
  }
});

test("editor sees registered check IDs in its prompt and schema and receives useful errors", async () => {
  const h = manual(),
    fake = scripted([reply('{"done":true}')]);
  await h.service.session("manual", "samurai", { phase: "edit" }, fake.model);
  const input = fake.inputs[0];
  expect(input.messages[0].content).toContain("Registered check IDs: pytest");
  expect(input.messages[0].content).toContain(
    "smallest suitable source change",
  );
  expect(input.messages[0].content).toContain("immediately finish");
  const command = input.tools.find(
    (tool: any) => tool.function.name === "run_cmd",
  );
  expect(command.function.parameters.properties.check_id.enum).toEqual([
    "pytest",
  ]);
  h.service.state("manual", "IMPLEMENTING");
  h.service.store.db
    .query("UPDATE missions SET current_rev=? WHERE id=?")
    .run(`r0:sha256:${treeHash(h.source)}`, "manual");
  const invalid: any = await h.service.tool(
    "manual",
    "samurai",
    "run_cmd",
    { check_id: "lint" },
    "wrong-check",
  );
  expect(invalid.ok).toBe(false);
  expect(invalid.error).toMatchObject({
    code: "COMMAND_NOT_ALLOWED",
    allowed_check_ids: ["pytest"],
  });
  expect(invalid.error.message).toContain("pytest");
  const result: any = await h.service.tool(
    "manual",
    "samurai",
    "run_check",
    { check_id: "pytest" },
    "registered-check",
  );
  expect(result.ok).toBe(true);
  expect(result.data.exit_code).toBe(1);
});

test("editor blocks protected test files and emits an informational documentation finding", async () => {
  const h = manual();
  writeFileSync(join(h.source, "README.md"), "old documentation\n");
  const base = treeHash(h.source),
    initial = join(h.root, "runtime", "missions", "manual", "r0");
  mkdirSync(initial, { recursive: true });
  copyTree(h.source, initial);
  h.service.store.db
    .query("UPDATE missions SET state=?,base_hash=?,current_rev=? WHERE id=?")
    .run("IMPLEMENTING", base, `r0:sha256:${base}`, "manual");
  const paths = [
    "tests/test_a.py",
    "test_alpha.py",
    "nested/foo_test.py",
    "conftest.py",
    "pytest.ini",
    "pyproject.toml",
    "setup.cfg",
    "tox.ini",
    ".github/workflows/check.yml",
    "package.json",
  ];
  for (const [index, path] of paths.entries()) {
    const result: any = await h.service.tool(
      "manual",
      "samurai",
      "edit_file",
      { path, old_text: "", new_text: "altered" },
      `protected-${index}`,
    );
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PROTECTED_FILE");
    expect(result.error.message).toContain("not permitted");
  }
  expect(h.service.store.events("manual").some((e) => e.type === "diff")).toBe(
    false,
  );
  const edited: any = await h.service.tool(
    "manual",
    "samurai",
    "edit_file",
    {
      path: "./README.md",
      old_text: "old documentation",
      new_text: "new documentation",
    },
    "docs-edit",
  );
  expect(edited.ok).toBe(true);
  const events = h.service.store.events("manual"),
    finding = events.find((e) => e.type === "finding")!;
  expect(finding.payload).toMatchObject({
    severity: "info",
    blocking: false,
    action: "open",
    title: "Documentation changed",
  });
  expect(finding.payload.evidence_event_ids).toContain(
    events.find((e) => e.type === "diff")!.id,
  );
  expect(
    readFileSync(
      join(h.service.store.get("manual").snapshot, "README.md"),
      "utf8",
    ),
  ).toContain("new documentation");
});

test("per-role budgets are independent and a configurable mission cap still applies", () => {
  const h = manual();
  for (let i = 0; i < 6; i++) h.service.reserve("manual", "turns", "shogun");
  expect(() => h.service.reserve("manual", "turns", "shogun")).toThrow(
    "TURN_LIMIT",
  );
  for (let i = 0; i < 16; i++) h.service.reserve("manual", "turns", "samurai");
  expect(() => h.service.reserve("manual", "turns", "samurai")).toThrow(
    "TURN_LIMIT",
  );
  h.service.reserve("manual", "turns", "shadow_review");
  const usage = h.service.store.usage("manual");
  expect(usage.per_agent.shogun!.turns).toBe(6);
  expect(usage.per_agent.samurai!.turns).toBe(16);
  expect(usage.total.turns).toBe(23);
  expect(h.service.store.get("manual").turns).toBe(23);

  const limited = manual();
  limited.service.budgetConfig = { missionTurns: 2 };
  limited.service.reserve("manual", "turns", "shogun");
  limited.service.reserve("manual", "turns", "samurai");
  expect(() =>
    limited.service.reserve("manual", "turns", "shadow_security"),
  ).toThrow("TURN_LIMIT");
  expect(limited.service.store.usage("manual").total.turns).toBe(2);
  expect(turnBudgets("Add a feature").roles.samurai).toBeGreaterThan(
    turnBudgets("Fix a defect").roles.samurai!,
  );
  const previous = process.env.DEVPILOT_MISSION_TURN_LIMIT;
  try {
    process.env.DEVPILOT_MISSION_TURN_LIMIT = "31";
    expect(turnBudgets("Fix a defect").mission).toBe(31);
  } finally {
    if (previous === undefined) delete process.env.DEVPILOT_MISSION_TURN_LIMIT;
    else process.env.DEVPILOT_MISSION_TURN_LIMIT = previous;
  }
});

test("turn-limit escalation identifies the role and cites recent activity", async () => {
  const env = environment();
  const fake = scripted([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "read",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "main.py" }),
          },
        },
      ],
    },
  ]);
  const service = new Service({
    root: join(env.root, "runtime"),
    registry: env.registry,
    runner,
    model: fake.model,
    roleTurnLimits: { shogun: 1 },
  });
  resources.push(() => service.close());
  const mid = service.create("tiny", env.request);
  await waitFor(() => service.store.get(mid).state === "ESCALATED");
  const events = service.store.events(mid),
    escalation = events.find((e) => e.type === "escalation")!,
    toolResult = events.find((e) => e.type === "tool_result")!;
  expect(escalation.payload.reason).toBe("TURN_LIMIT");
  expect(escalation.payload.question).toContain("shogun");
  expect(escalation.payload.question).toContain("1-turn role budget");
  expect(escalation.payload.relevant_event_ids).toContain(toolResult.id);
  expect(escalation.payload.evidence_ids).toContain(toolResult.id);
});

test("legacy SQLite mission budgets migrate without losing event references", async () => {
  const { Database } = await import("bun:sqlite");
  const { Store } = await import("../src/store");
  const root = mkdtempSync(join(tmpdir(), "devpilot-legacy-budget-"));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "legacy.db"),
    old = new Database(path);
  old.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE missions(id TEXT PRIMARY KEY, turns INTEGER NOT NULL DEFAULT 0 CHECK(turns BETWEEN 0 AND 20), baseline_of TEXT REFERENCES missions(id), paired_mission_id TEXT REFERENCES missions(id));
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, mission_id TEXT NOT NULL REFERENCES missions(id), type TEXT NOT NULL, agent TEXT NOT NULL, task_id TEXT, code_rev TEXT, verified INTEGER NOT NULL, payload TEXT NOT NULL);
    INSERT INTO missions(id,turns) VALUES('old',3);
    INSERT INTO missions(id,turns,baseline_of) VALUES('baseline',1,'old');
    UPDATE missions SET paired_mission_id='baseline' WHERE id='old';
    INSERT INTO events(ts,mission_id,type,agent,verified,payload) VALUES(1,'old','mission_started','system',1,'{}');`);
  old.close();
  const store = new Store(path);
  resources.push(() => store.close());
  expect(store.get("old").turns).toBe(3);
  expect(store.get("baseline").baseline_of).toBe("old");
  expect(store.get("old").paired_mission_id).toBe("baseline");
  store.db.query("UPDATE missions SET turns=21 WHERE id=?").run("old");
  expect(store.get("old").turns).toBe(21);
  expect(store.events("old")).toHaveLength(1);
  expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("terminal missions cancel in-flight model calls", async () => {
  const env = environment();
  let started = false,
    aborted = false;
  const model: Model = {
    async complete(_role, _messages, _tools, signal) {
      started = true;
      await new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Error("ABORTED"));
          },
          { once: true },
        ),
      );
      return reply("{}");
    },
  };
  const service = new Service({
    root: join(env.root, "runtime"),
    registry: env.registry,
    runner,
    model,
  });
  resources.push(() => service.close());
  const mid = service.create("tiny", env.request);
  await waitFor(() => started);
  service.escalate(mid, "TURN_LIMIT", "Stop the mission.");
  await waitFor(() => aborted);
  expect(service.store.get(mid).state).toBe("ESCALATED");
});
