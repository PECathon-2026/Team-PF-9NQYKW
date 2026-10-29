// Display names for contract identifiers. Raw ids stay in tooltips and monospace text.
import type { Agent, EventType } from "./types";

export const AGENT_NAMES: Record<Agent, string> = {
  orchestrator: "Orchestrator", shogun: "Shogun", samurai: "Samurai", sentinel: "Sentinel", verifier: "Verifier",
  shadow_review: "Shadow Review", shadow_security: "Shadow Security", baseline: "Baseline", human: "You", system: "System",
};
export const agentName = (id: string) => AGENT_NAMES[id as Agent] ?? humanize(id);

export const EVENT_LABELS: Record<EventType, string> = {
  mission_started: "Mission started", plan: "Plan published", task_update: "Task updated", agent_msg: "Message",
  turn_start: "Turn started", turn_end: "Turn ended", tool_call: "Tool call", tool_result: "Tool result",
  test_result: "Check result", finding: "Finding", diff: "New revision",
  approval_needed: "Approval requested", approval_requested: "Approval requested", approval_result: "Decision recorded",
  escalation: "Escalated", stale: "Evidence invalidated", mission_done: "Mission finished", usage: "Usage report",
};
export const eventLabel = (type: string) => EVENT_LABELS[type as EventType] ?? humanize(type);

const STATES: Record<string, string> = {
  WAITING: "Waiting", PLANNING: "Planning", IMPLEMENTING: "Implementing", EVALUATING: "Checking",
  AWAITING_APPROVAL: "Awaiting approval", APPLYING: "Applying", REJECTED: "Rejected", ESCALATED: "Escalated",
  COMPLETED: "Completed", DONE: "Completed", FAILED: "Failed",
};
export const stateLabel = (s: string) => STATES[s.toUpperCase()] ?? humanize(s);

export const CONNECTION: Record<string, string> = { idle: "Idle", connecting: "Connecting", live: "Live", reconnecting: "Reconnecting" };

/** "AMBIGUOUS_REQUEST" or "sent_back" -> "Ambiguous request" / "Sent back". Leaves prose untouched. */
export function humanize(s: string): string {
  if (!/^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/.test(s)) return s;
  const words = s.replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
