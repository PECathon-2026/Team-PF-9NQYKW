import { describe, expect, test } from "bun:test";
import { agentTurns, blocksGate, buildPatch, col, derive, deriveDeadline, isOpen, revisionDiffs, secondsLeft, stageState, tamperText } from "./derive";
import { agentName } from "./labels";
import { LOCAL_CATALOG, REQUESTS, normalizeRequests } from "./requests";
import { REPOS, type Agent, type EventType, type MissionEvent } from "./types";

const event = (id: number, type: EventType, agent: Agent, payload: Record<string, unknown> = {}): MissionEvent => ({
  id, ts: id * 1000, mission_id: "mission", type, agent, task_id: null, code_rev: null, verified: true, payload,
});

describe("pipeline stage state", () => {
  test("an open tool call stays working until its result, including a system result", () => {
    const call = event(1, "tool_call", "samurai", { call_id: "call" });
    expect(stageState([call], "samurai", 100000)).toBe("work");
    const result = event(2, "tool_result", "system", { call_id: "call", ok: true });
    expect(stageState([result, call], "samurai", 2000)).toBe("done");
    expect(stageState([call, result], "sentinel", 2000)).toBe("idle");
  });

  test("a later completion or new action determines the state", () => {
    const start = event(1, "turn_start", "shogun");
    const end = event(2, "turn_end", "shogun");
    expect(stageState([start], "shogun", 1000)).toBe("work");
    expect(stageState([start, end], "shogun", 2000)).toBe("done");
    expect(stageState([start, event(2, "agent_msg", "shogun")], "shogun", 2000)).toBe("done");
    expect(stageState([start, end, event(3, "tool_call", "shogun", { call_id: "next" })], "shogun", 3000)).toBe("work");
    expect(stageState([event(1, "tool_call", "shogun", { call_id: "old" }), event(2, "tool_call", "shogun", { call_id: "new" }), event(3, "tool_result", "system", { call_id: "old" })], "shogun", 3000)).toBe("work");
  });

  test("approval and completion close open activity without marking other agents done", () => {
    const call = event(1, "tool_call", "samurai", { call_id: "call" });
    for (const gate of ["approval_needed", "approval_requested", "mission_done"] as const) {
      const events = [call, event(2, gate, "orchestrator")];
      expect(stageState(events, "samurai", 2000)).toBe("done");
      expect(stageState(events, "sentinel", 2000)).toBe("idle");
    }
    const events = [call, event(2, "approval_needed", "orchestrator"), event(3, "approval_result", "human")];
    expect(stageState(events, "samurai", 3000)).toBe("done");
    expect(stageState([...events, event(4, "turn_start", "samurai")], "samurai", 4000)).toBe("work");
  });

  test("failed tests retain their brief failed state", () => {
    const failure = event(1, "test_result", "sentinel", { outcome: "failed" });
    expect(stageState([failure], "sentinel", 2000)).toBe("failed");
    expect(stageState([failure], "sentinel", 5000)).toBe("done");
    expect(stageState([failure, event(2, "mission_done", "orchestrator")], "sentinel", 2000)).toBe("done");
  });
});

const at = (e: MissionEvent, patch: Partial<MissionEvent>): MissionEvent => ({ ...e, ...patch });
const count = (turns: number) => ({ turns, input_tokens: 0, output_tokens: 0 });

describe("turn counters", () => {
  test("pass_turns is read from the top level of the usage payload", () => {
    const usage = event(1, "usage", "orchestrator", { per_agent: { shadow_review: count(7), samurai: count(5) }, total: count(12), pass_turns: { shadow_review: 2, samurai: 1 } });
    const v = derive([usage]);
    expect(v.usage?.pass_turns).toEqual({ shadow_review: 2, samurai: 1 });
    expect(agentTurns(v.usage, "shadow_review")).toBe(2);
    // Samurai's budget spans the mission, so its cumulative count applies.
    expect(agentTurns(v.usage, "samurai")).toBe(5);
  });

  test("falls back to cumulative turns when pass_turns is absent or malformed", () => {
    const old = derive([event(1, "usage", "orchestrator", { per_agent: { shadow_review: count(3) }, total: count(3) })]);
    expect(agentTurns(old.usage, "shadow_review")).toBe(3);
    expect(agentTurns(old.usage, "verifier")).toBeUndefined();
    const bad = derive([event(1, "usage", "orchestrator", { per_agent: { shadow_review: count(3) }, total: count(3), pass_turns: { shadow_review: -1 } })]);
    expect(agentTurns(bad.usage, "shadow_review")).toBe(3);
  });

  test("mission_done keeps the last reported pass_turns", () => {
    const v = derive([
      event(1, "usage", "orchestrator", { per_agent: { verifier: count(1) }, total: count(1), pass_turns: { verifier: 0 } }),
      event(2, "mission_done", "orchestrator", { status: "COMPLETED", per_agent: { verifier: count(1) }, total: count(1) }),
    ]);
    expect(agentTurns(v.usage, "verifier")).toBe(0);
  });
});

describe("deadline", () => {
  const started = event(1, "mission_started", "orchestrator", { deadline: 100000, deadline_max: 400000 });

  test("uses the initial deadline, then any later extension", () => {
    expect(deriveDeadline([started]).deadline).toBe(100000);
    const blocked = event(5, "task_update", "orchestrator", { task_id: "t", status: "blocked", deadline: 160000 });
    const sendBack = event(6, "agent_msg", "orchestrator", { to: "samurai", message: "fix", deadline: 160000 });
    const v = derive([sendBack, blocked, started]);
    expect(v.deadline).toBe(160000);
    expect(secondsLeft(v, 100000)).toEqual({ left: 60, paused: false });
    expect(deriveDeadline([started, event(7, "agent_msg", "orchestrator", { deadline: 220000 })]).deadline).toBe(220000);
  });

  test("ignores deadlines on unverified (model-claimed) events", () => {
    const claim = at(event(2, "agent_msg", "shogun", { deadline: 999999 }), { verified: false });
    expect(deriveDeadline([started, claim]).deadline).toBe(100000);
  });

  test("pauses at the approval gate and resumes with the saved remainder", () => {
    const gate = event(10, "approval_needed", "orchestrator", { deadline_paused: true, deadline_remaining_ms: 30000 });
    const paused = deriveDeadline([started, gate]);
    expect(paused.pausedRemainingMs).toBe(30000);
    expect(secondsLeft(paused, 500000)).toEqual({ left: 30, paused: true });
    const result = at(event(11, "approval_result", "human", { decision: true }), { ts: 200000 });
    const resumed = deriveDeadline([started, gate, result]);
    expect(resumed).toEqual({ deadline: 230000, pausedRemainingMs: undefined });
  });

  test("no deadline reported means no countdown", () => {
    expect(secondsLeft(derive([event(1, "plan", "shogun")]), 0)).toBeNull();
  });
});

describe("fix cycles", () => {
  test("counts repair dispatches to the editor in both multi and baseline modes", () => {
    const v = derive([
      event(1, "agent_msg", "orchestrator", { to: "samurai", message: "fix" }),
      event(2, "agent_msg", "orchestrator", { to: "baseline", message: "fix" }),
      event(3, "agent_msg", "verifier", { recipient: "baseline", message: "fix" }),
      event(4, "agent_msg", "shogun", { to: "samurai", message: "plan handoff" }),
      event(5, "agent_msg", "orchestrator", { to: "shadow_review", message: "review" }),
    ]);
    expect(v.fixCycles).toBe(3);
  });
});

describe("task status", () => {
  test("blocked is its own column, not pending", () => {
    expect(col("blocked")).toBe("blocked");
    expect(col("in_progress")).toBe("running");
    expect(col("completed")).toBe("done");
    expect(col("something_else")).toBe("pending");
    const v = derive([
      event(1, "plan", "shogun", { tasks: [{ id: "t", title: "Fix", role: "samurai", status: "in_progress" }] }),
      event(2, "task_update", "orchestrator", { task_id: "t", previous_status: "in_progress", status: "blocked", deadline: 1 }),
    ]);
    expect(col(v.tasks[0].status)).toBe("blocked");
  });
});

describe("approval evidence", () => {
  const R = "r1:sha256:tree";
  const mission = (evidence: number[]) => [
    event(1, "mission_started", "orchestrator", { base_hash: "base", deadline: 100000 }),
    at(event(2, "diff", "samurai", { base_hash: "base", revision: R, changed_paths: ["a.py"], text: "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x\n+y" }), { code_rev: R }),
    at(event(3, "test_result", "sentinel", { check_id: "unit", outcome: "passed", exit_code: 0, isolation: "isolated" }), { code_rev: R }),
    at(event(4, "approval_needed", "orchestrator", { approval_id: "ap", evidence_ids: evidence, tree_hash: "tree", decision: null, deadline_paused: true, deadline_remaining_ms: 5000 }), { code_rev: R }),
  ];

  test("a fully cited, passing revision clears the gate", () => {
    const v = derive(mission([2, 3]));
    expect(v.gate).toEqual({ ok: true, reasons: [] });
    expect(v.citations.map((c) => [c.id, c.event?.type, c.stale])).toEqual([[2, "diff", false], [3, "test_result", false]]);
  });

  test("a cited id with no matching event is marked missing and blocks the gate", () => {
    const v = derive(mission([3, 999]));
    expect(v.citations.find((c) => c.id === 999)?.event).toBeUndefined();
    expect(v.gate.ok).toBe(false);
    expect(v.gate.reasons).toContain("Approval cites missing evidence: #999");
  });

  test("citing nothing blocks the gate", () => {
    expect(derive(mission([])).gate.reasons).toContain("Approval cites no evidence");
  });

  test("the patch is the latest cumulative diff of the approved revision", () => {
    const v = derive(mission([2, 3]));
    const diffs = revisionDiffs(v.diffs, R);
    expect(diffs.map((d) => d.id)).toEqual([2]);
    expect(revisionDiffs(v.diffs, "r9:other")).toEqual([]);
    const patch = buildPatch(String(diffs[0].payload.text), { mission: "m1", revision: R, base: "base", tree: "tree" });
    expect(patch.startsWith("DevPilot mission m1\nRevision: r1:sha256:tree\nBase: base\nTree: tree\n\n--- a/a.py")).toBe(true);
    expect(patch.endsWith("+y\n")).toBe(true);
  });
});

describe("tamper findings", () => {
  const R = "r1:sha256:tree";
  // Shape emitted by service.ts for a refused PROTECTED_FILE / INVALID_PATH file-tool call.
  const refused = (id: number, call: string, code: string) => at(event(id, "tool_result", "samurai", { call_id: call, ok: false, error: { code } }), { code_rev: R });
  const tamper = (id: number, cite: number, tool: string, path: string, code: string) => at(event(id, "finding", "orchestrator", {
    finding_id: `f_t${id}`, severity: "info", blocking: false, action: "open",
    title: code === "PROTECTED_FILE" ? "Protected file edit blocked" : "Path escape blocked",
    detail: `samurai ${tool} on ${path} was refused (${code}).`, tamper: { tool, path, code }, evidence_event_ids: [cite],
  }), { code_rev: R });
  const mission = (extra: MissionEvent[]) => [
    event(1, "mission_started", "orchestrator", { base_hash: "base", deadline: 100000 }),
    refused(2, "c1", "PROTECTED_FILE"), tamper(3, 2, "edit_file", "tests/test_pricing.py", "PROTECTED_FILE"),
    refused(4, "c2", "INVALID_PATH"), tamper(5, 4, "read_file", "../../private/acceptance/cheat/test_acceptance_cheat.py", "INVALID_PATH"),
    at(event(6, "diff", "samurai", { base_hash: "base", revision: R, changed_paths: ["pricing.py"], text: "+fix" }), { code_rev: R }),
    at(event(7, "test_result", "sentinel", { check_id: "cheat.pytest", outcome: "passed", exit_code: 0, isolation: "isolated" }), { code_rev: R }),
    ...extra,
    at(event(20, "approval_needed", "orchestrator", { approval_id: "ap", evidence_ids: [6, 7], tree_hash: "tree" }), { code_rev: R }),
  ];

  test("are kept apart from findings and do not block the gate or count as open", () => {
    const v = derive(mission([]));
    expect(v.tampers.map((f) => f.id)).toEqual(["f_t3", "f_t5"]);
    expect(v.findings).toEqual([]);
    expect(v.tampers.some((f) => isOpen(f) || blocksGate(f))).toBe(false);
    expect(v.gate).toEqual({ ok: true, reasons: [] });
  });

  test("ignore a blocking flag on a tamper finding, while a real blocking finding still blocks", () => {
    const flagged = at(tamper(8, 2, "edit_file", "conftest.py", "PROTECTED_FILE"), {});
    flagged.payload.blocking = true; flagged.payload.severity = "high";
    expect(derive(mission([flagged])).gate.ok).toBe(true);
    const real = at(event(9, "finding", "shadow_review", { finding_id: "f_r", severity: "high", blocking: true, action: "open", title: "Rounding", evidence_event_ids: [] }), { code_rev: R });
    const v = derive(mission([real]));
    expect(v.findings.filter(isOpen).map((f) => f.id)).toEqual(["f_r"]);
    expect(v.gate.reasons).toContain("A blocking finding is still open");
  });

  test("are labelled by tool and refusal code, attributed to the refused call's agent", () => {
    const [edit, escape] = derive(mission([])).tampers;
    expect(tamperText(edit.tamper!)).toBe("tried to edit tests/test_pricing.py");
    expect(edit.tamper!.code).toBe("PROTECTED_FILE");
    expect(tamperText(escape.tamper!)).toBe("tried to escape the workspace via ../../private/acceptance/cheat/test_acceptance_cheat.py");
    expect(tamperText({ tool: "read_file", path: "secrets.env", code: "PROTECTED_FILE" })).toBe("tried to read secrets.env");
    expect(tamperText({ tool: "write_file", path: "pytest.ini", code: "PROTECTED_FILE" })).toBe("tried to edit pytest.ini");
    expect(edit.actor).toBe("samurai");
    expect(edit.evidenceIds).toEqual([2]);
    expect(agentName(edit.agent)).toBe("Orchestrator");
  });

  test("only the orchestrator can mark a finding as a tamper attempt", () => {
    const spoof = at(event(10, "finding", "shadow_review", { finding_id: "f_s", severity: "high", blocking: true, action: "open", title: "x", tamper: { tool: "edit_file", path: "a", code: "PROTECTED_FILE" } }), { code_rev: R });
    const v = derive(mission([spoof]));
    expect(v.findings.map((f) => f.id)).toEqual(["f_s"]);
    expect(v.gate.reasons).toContain("A blocking finding is still open");
  });

  test("orchestrator usage per_agent is accepted", () => {
    const v = derive([event(1, "usage", "orchestrator", { per_agent: { orchestrator: count(0), samurai: count(2) }, total: count(2) })]);
    expect(v.usage?.per_agent.orchestrator.turns).toBe(0);
  });
});

describe("reviewer finding resolution fields", () => {
  test("carried_forward and unaccepted_resolution stay blocking; resolution_evidence is kept", () => {
    const v = derive([
      event(1, "finding", "shadow_security", { finding_id: "f_c", severity: "critical", blocking: true, action: "open", title: "Escape", evidence_event_ids: [3] }),
      event(2, "finding", "shadow_security", { finding_id: "f_c", severity: "critical", blocking: true, action: "open", title: "Escape", carried_forward: true, evidence_event_ids: [4] }),
      event(5, "finding", "shadow_review", { finding_id: "f_u", severity: "critical", blocking: true, action: "open", title: "Bad", unaccepted_resolution: "The candidate tree has not changed since this critical finding blocked." }),
      event(6, "finding", "verifier", { finding_id: "f_ok", severity: "low", blocking: false, action: "open", title: "Fixed", resolution_evidence: { path: "store.py", line: 12 }, evidence_event_ids: [5] }),
    ]);
    const by = Object.fromEntries(v.findings.map((f) => [f.id, f]));
    expect(by.f_c.carriedForward).toBe(true);
    expect(by.f_c.evidenceIds).toEqual([4]);
    expect(blocksGate(by.f_c)).toBe(true);
    expect(by.f_u.unacceptedResolution).toContain("has not changed");
    expect(blocksGate(by.f_u)).toBe(true);
    expect(by.f_ok.resolutionEvidence).toEqual({ path: "store.py", line: 12 });
    expect(blocksGate(by.f_ok)).toBe(false);
  });
});

describe("registered requests", () => {
  test("the cheat red-team fixture is listed locally", () => {
    expect(REPOS).toContain("cheat");
    expect(LOCAL_CATALOG.cheat).toEqual([REQUESTS.cheat]);
    expect(normalizeRequests([{ repo: "cheat", request: "C" }])?.cheat).toEqual(["C"]);
  });

  test("accepts list and map shapes; unusable bodies fall back", () => {
    expect(normalizeRequests([{ repo: "stock", request: "A" }, { repo: "nope", request: "B" }])?.stock).toEqual(["A"]);
    expect(normalizeRequests({ requests: [{ repo: "cart", request: "C" }] })?.cart).toEqual(["C"]);
    expect(normalizeRequests({ notes: ["N1", "N2"] })?.notes).toEqual(["N1", "N2"]);
    expect(normalizeRequests({ notes: ["N1"] })?.stock).toEqual(LOCAL_CATALOG.stock);
    expect(normalizeRequests("<!doctype html>")).toBeNull();
    expect(normalizeRequests([])).toBeNull();
  });
});
