import { isBudget, isUnisolated, type Agent, type MissionEvent, type UsageCount } from "./types";

const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
/** Task status normalization: backend uses in_progress/completed. */
export const col = (s: string) => (s === "in_progress" || s === "running" ? "running" : s === "completed" || s === "done" ? "done" : s === "ready" ? "ready" : "pending");
export const isResolved = (a: string) => a === "resolve" || a === "resolved";
export const approved = (e?: MissionEvent) => !!e && (e.payload.decision === true || e.payload.decision === "approved");

export interface Task { id: string; title: string; role: string; status: string; deps: string[] }
export interface CheckRow { key: string; kind: "check" | "acceptance"; outcome: string; code_rev: string | null; event: MissionEvent; attempts: number; stale: boolean; duration?: number; exit?: number }
export interface Finding { id: string; agent: string; severity: string; action: string; description: string; blocking: boolean; resolution: string; sentBack: boolean; code_rev: string | null; stale: boolean; eventId: number; verified: boolean }

export type StageState = "idle" | "work" | "done" | "failed";

/** Derive activity from ordered events, rather than task status or event recency. */
export function stageState(input: MissionEvent[], agent: Agent, now: number): StageState {
  const events = [...input].sort((a, b) => a.id - b.id);
  const calls = new Map<unknown, { agent: Agent; id: number }>();
  let action: "idle" | "work" | "done" = "idle";
  let lastStart = -1; let lastAgentEvent: MissionEvent | undefined;
  let awaitingApproval = false; let finished = false;

  for (const e of events) {
    if (e.type === "approval_needed" || e.type === "approval_requested") { awaitingApproval = true; if (action === "work") action = "done"; }
    if (e.type === "approval_result") awaitingApproval = false;
    if (e.type === "mission_done") { finished = true; if (action === "work") action = "done"; }
    if (e.type === "tool_call" && e.payload.call_id != null) calls.set(e.payload.call_id, { agent: e.agent, id: e.id });
    if (e.agent === agent) lastAgentEvent = e;
    if (e.type === "tool_result") {
      const call = calls.get(e.payload.call_id);
      if (call) {
        if (call.agent === agent && call.id === lastStart) action = "done";
        calls.delete(e.payload.call_id);
      } else if (e.agent === agent) action = "done";
    } else if (e.agent === agent) {
      if (e.type === "tool_call" || e.type === "turn_start") { action = awaitingApproval || finished ? "done" : "work"; lastStart = e.id; }
      else if (["turn_end", "agent_msg", "plan", "test_result", "finding", "diff"].includes(e.type)) action = "done";
    }
  }
  // Preserve the existing brief indication for a failed test, except after mission completion.
  if (!finished && lastAgentEvent?.type === "test_result" && lastAgentEvent.payload.outcome !== "passed" && now - lastAgentEvent.ts < 4000) return "failed";
  return action === "work" && (awaitingApproval || finished) ? "done" : action;
}

export interface View {
  events: MissionEvent[]; staleIds: Set<number>; staleBy: Map<number, MissionEvent>;
  started?: MissionEvent; plan?: MissionEvent; tasks: Task[]; checks: CheckRow[]; findings: Finding[];
  diffs: MissionEvent[]; currentRev: string | null; pendingApproval?: MissionEvent; approvalResult?: MissionEvent;
  escalations: MissionEvent[]; done?: MissionEvent; state: string; gate: { ok: boolean; reasons: string[] };
  usage?: { total: UsageCount; per_agent: Record<string, UsageCount> }; budget?: Record<string, number>; pairedMissionId?: string; unisolated: Set<number>;
  fixCycles: number; toolFailures: number;
}

export function derive(input: MissionEvent[]): View {
  const events = [...input].sort((a, b) => a.id - b.id);
  const staleIds = new Set<number>(); const staleBy = new Map<number, MissionEvent>();
  let currentRev: string | null = null; let started: MissionEvent | undefined; let plan: MissionEvent | undefined;
  const tasks = new Map<string, Task>(); const diffs: MissionEvent[] = []; const escalations: MissionEvent[] = [];
  let pendingApproval: MissionEvent | undefined; let approvalResult: MissionEvent | undefined; let done: MissionEvent | undefined;
  const findingsMap = new Map<string, Finding>(); const tests: MissionEvent[] = [];
  let usage: View["usage"]; let budget: View["budget"]; const unisolated = new Set<number>();
  let toolFailures = 0; let lastStaleId = 0;

  for (const e of events) {
    const p = e.payload;
    if (isUnisolated(e)) unisolated.add(e.id);
    if (e.type === "mission_started" && e.code_rev && !currentRev) currentRev = e.code_rev;
    if (e.code_rev && (e.type === "diff" || e.type === "stale")) currentRev = e.type === "stale" ? str(p.new_revision, currentRev ?? "") || currentRev : e.code_rev;
    switch (e.type) {
      case "mission_started": started = e; break;
      case "plan": {
        plan = e;
        for (const t of Array.isArray(p.tasks) ? p.tasks : []) {
          const o = t as Record<string, unknown>; const id = str(o.id); if (!id) continue;
          tasks.set(id, { id, title: str(o.title, id), role: str(o.role ?? o.agent, ""), status: str(o.status, tasks.get(id)?.status ?? "pending"), deps: Array.isArray(o.deps) ? o.deps.map((d) => str(d)) : [] });
        }
        break;
      }
      case "task_update": {
        const id = str(p.task_id ?? e.task_id); if (!id) break;
        const t = tasks.get(id) ?? { id, title: id, role: e.agent, status: "pending", deps: [] };
        t.status = str(p.new_status ?? p.status, t.status); tasks.set(id, t); break;
      }
      case "usage": usage = { total: p.total, per_agent: p.per_agent } as View["usage"]; if (isBudget(p.budget)) budget = p.budget; break;
      case "mission_done": done = e; if (p.total && p.per_agent) usage = { total: p.total, per_agent: p.per_agent } as View["usage"]; break;
      case "tool_result": if (p.ok === false) toolFailures++; break;
      case "test_result": tests.push(e); break;
      case "finding": {
        const id = str(p.finding_id, `f${e.id}`); const prev = findingsMap.get(id);
        const action = str(p.action, "opened");
        findingsMap.set(id, {
          id, agent: prev?.agent ?? e.agent, severity: str(p.severity, prev?.severity ?? "info"), action,
          description: [str(p.title), str(p.detail ?? p.description)].filter(Boolean).join(" — ") || prev?.description || "", blocking: typeof p.blocking === "boolean" ? p.blocking : prev?.blocking ?? false,
          resolution: str(p.resolution, prev?.resolution ?? ""), sentBack: (prev?.sentBack ?? false) || action === "sent_back" || p.sent_back === true,
          code_rev: e.code_rev, stale: false, eventId: e.id, verified: e.verified,
        });
        break;
      }
      case "diff": diffs.push(e); break;
      case "approval_needed": case "approval_requested": pendingApproval = e; approvalResult = undefined; break;
      case "approval_result": approvalResult = e; break;
      case "escalation": escalations.push(e); break;
      case "stale": {
        lastStaleId = e.id;
        for (const i of [...ids(p.invalidated), ...ids(p.affected_evidence_ids), ...ids(p.evidence_ids)]) { staleIds.add(i); staleBy.set(i, e); }
        break;
      }
    }
  }

  // Test rows: latest result per check/suite id, with attempt count across revisions.
  const byKey = new Map<string, MissionEvent[]>();
  for (const t of tests) { const k = str(t.payload.suite_id ?? t.payload.check_id, "check"); byKey.set(k, [...(byKey.get(k) ?? []), t]); }
  const checks: CheckRow[] = [...byKey].map(([key, list]) => {
    const last = list[list.length - 1]; const pl = last.payload;
    return { key, kind: pl.suite_id ? "acceptance" : "check", outcome: str(pl.outcome, "unknown"), code_rev: last.code_rev, event: last, attempts: list.length,
      stale: staleIds.has(last.id) || (!!currentRev && last.code_rev !== currentRev),
      duration: typeof pl.duration === "number" ? pl.duration : typeof pl.duration_ms === "number" ? pl.duration_ms : undefined, exit: typeof pl.exit_code === "number" ? pl.exit_code : undefined };
  });
  const findings = [...findingsMap.values()].map((f) => ({ ...f, stale: staleIds.has(f.eventId) }));

  // Approval gate (client-side mirror; the server remains authoritative).
  const reasons: string[] = [];
  if (approvalResult) reasons.push("Decision already recorded");
  if (done) reasons.push("Mission finished");
  if (!pendingApproval) reasons.push("No approval requested");
  else {
    const ar = pendingApproval;
    if (!diffs.length) reasons.push("No diff — candidate is the unchanged base");
    if (!ar.code_rev || ar.code_rev !== currentRev) reasons.push("Approval is for a different revision than the current code");
    if (lastStaleId > ar.id) reasons.push("Evidence went stale after approval was requested");
    const ev = ids(ar.payload.evidence_ids);
    if (ev.some((i) => staleIds.has(i))) reasons.push("Approval cites stale evidence");
    const evEvents = events.filter((x) => ev.includes(x.id));
    if (evEvents.some((x) => unisolated.has(x.id))) reasons.push("Approval cites unisolated evidence");
    if (evEvents.some((x) => x.code_rev !== ar.code_rev)) reasons.push("Approval cites evidence from another revision");
    if (checks.length === 0) reasons.push("No checks have run");
    for (const c of checks) {
      if (c.code_rev !== ar.code_rev) reasons.push(`${c.key} has not rerun on ${short(ar.code_rev)}`);
      else if (unisolated.has(c.event.id)) reasons.push(`${c.key} ran without isolation`);
      else if (!c.event.verified) reasons.push(`${c.key} result is not observed (claim only)`);
      else if (c.outcome !== "passed") reasons.push(`${c.key} ${c.outcome}`);
      if (c.stale) reasons.push(`${c.key} is stale`);
    }
    if (findings.some((f) => f.blocking && !isResolved(f.action))) reasons.push("Blocking finding still open");
  }

  const state = done ? str(done.payload.status, "DONE").toUpperCase()
    : escalations.length ? "ESCALATED" : approvalResult ? (approved(approvalResult) ? "APPLYING" : "REJECTED")
    : pendingApproval ? "AWAITING_APPROVAL" : diffs.length ? (tests.some((t) => t.code_rev === currentRev) ? "EVALUATING" : "IMPLEMENTING")
    : plan ? "PLANNING" : started ? "PLANNING" : "WAITING";
  // Each repair dispatch is one cycle; findings and revisions can be many per dispatch.
  const fixCycles = new Set(events.filter((e) => e.type === "agent_msg"
    && ["orchestrator", "shadow_review", "shadow_security", "verifier"].includes(e.agent)
    && (e.payload.to ?? e.payload.recipient) === "samurai").map((e) => e.id)).size;
  return { events, staleIds, staleBy, started, plan, tasks: [...tasks.values()], checks, findings, diffs, currentRev, pendingApproval, approvalResult, escalations, done, state, gate: { ok: reasons.length === 0, reasons }, usage, budget, unisolated, pairedMissionId: str(started?.payload.paired_mission_id) || str(started?.payload.baseline_of) || undefined, fixCycles, toolFailures };
}
export const short = (rev: string | null | undefined) => (rev ? (rev.length > 18 ? rev.slice(0, 18) + "…" : rev) : "—");
