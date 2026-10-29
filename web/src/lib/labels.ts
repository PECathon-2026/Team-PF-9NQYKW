// Display names for contract identifiers. Raw ids stay in tooltips and monospace text.
import type { Agent, EventType } from "./types";

export const AGENT_NAMES: Record<Agent, string> = {
  orchestrator: "Orchestrator", shogun: "Shogun", samurai: "Samurai", sentinel: "Sentinel", verifier: "Verifier",
  shadow_review: "Shadow Review", shadow_security: "Shadow Security", baseline: "Baseline", human: "You", system: "System",
};
export const agentName = (id: string) => AGENT_NAMES[id as Agent] ?? humanize(id);

export const AGENT_ROLES: Record<Agent, string> = {
  orchestrator: "Coordinates the mission", shogun: "Plans the work", samurai: "Makes the code changes",
  sentinel: "Runs the visible tests", verifier: "Runs the hidden acceptance tests",
  shadow_review: "Reviews the code for problems", shadow_security: "Reviews the code for security risks",
  baseline: "Works alone on the same request", human: "Makes the final decision", system: "Records mission events",
};
export const agentRole = (id: string) => AGENT_ROLES[id as Agent] ?? "Participates in the mission";

export const MISSION_TABS = [
  { id: "overview", label: "Overview", subtitle: "Summary & plan" },
  { id: "evidence", label: "Evidence", subtitle: "Test results & findings" },
  { id: "diff", label: "Diff", subtitle: "Code changes" },
  { id: "activity", label: "Activity", subtitle: "Full event log" },
  { id: "approval", label: "Approval", subtitle: "Your decision" },
] as const;
export type MissionTab = (typeof MISSION_TABS)[number]["id"];

export const HELP = {
  visibleTests: "Tests in the repository that the agents can see and run.",
  pytest: "Tests in the repository that the agents can see and run. Pytest is a Python test runner.",
  acceptanceTests: "DevPilot's private tests the agents never see.",
  registeredCheck: "A check registered for this repository and run by the agents.",
  runs: "How many times this test or check has run during the mission, including earlier versions.",
  version: "The numbered state of the proposed code. The hash identifies its exact contents.",
  verified: "Observed by DevPilot itself; this does not mean the result passed or a conclusion is correct.",
  claimed: "Stated by an agent, not independently checked.",
  outdated: "This result belongs to an older version or was invalidated by a later change.",
  unisolated: "Run without a protected environment. This result cannot satisfy the approval requirements.",
  fixRounds: "A fix round is a send-back to the editing agent to address feedback. Up to 3 are allowed.",
  turns: "The number of model responses used by the agents during this mission.",
  tokens: "The total input and output text processed by the models.",
  changedSnapshot: "A hash identifying the exact snapshot of the proposed changed files.",
  originalSnapshot: "A hash identifying the repository snapshot from before this mission's changes.",
  isolation: "Whether the tests ran in a protected environment separate from the host.",
  findings: "Issues reported during review. A blocking open finding prevents approval.",
  exitCode: "The test command's exit code; zero means it completed successfully.",
  milliseconds: "Milliseconds measure duration; 1,000 milliseconds is one second.",
  tool: "A tool is a program an agent uses to inspect, change or check the repository.",
  patch: "A downloadable file describing the code changes from the original repository snapshot.",
} as const;

export type CheckKind = "check" | "acceptance";
export function checkLabel(id: string, kind: CheckKind): string {
  if (kind === "acceptance") return "Hidden acceptance tests";
  if (/(?:^|[.\/_-])pytest$/i.test(id)) return "Visible tests (pytest)";
  if (/(?:^|[.\/_-])unit$/i.test(id)) return "Visible tests (unit)";
  const name = id.split(/[.\/]/).pop() || id;
  return name && name !== "check" ? `Registered check (${humanize(name)})` : "Registered check";
}
export const checkHelp = (id: string, kind: CheckKind) => kind === "acceptance" ? HELP.acceptanceTests
  : /(?:^|[.\/_-])pytest$/i.test(id) ? HELP.pytest
  : /(?:^|[.\/_-])unit$/i.test(id) ? HELP.visibleTests : HELP.registeredCheck;

export function versionLabel(revision: string | null | undefined): string {
  if (!revision) return "Not recorded yet";
  const match = /^r(\d+)(?::|$)/i.exec(revision);
  return match ? `Version ${Number(match[1])} of the change` : "Code version";
}
export function versionPhrase(revision: string | null | undefined): string {
  if (!revision) return "the latest version";
  const match = /^r(\d+)(?::|$)/i.exec(revision);
  return match ? `version ${Number(match[1])}` : "the current version";
}
export const sourceLabel = (verified: boolean) => verified ? "Verified" : "Agent-reported";
export const sourceHelp = (verified: boolean) => verified ? HELP.verified : HELP.claimed;
export const OUTDATED_LABEL = "Outdated (older version)";

/** Translate gate explanations for display without changing the gate's rules. */
export function gateReason(reason: string, checks: readonly { key: string; kind: CheckKind }[] = []): string {
  const fixed: Record<string, string> = {
    "Decision already recorded": "A decision has already been recorded.",
    "Mission finished": "The mission has finished.",
    "No approval requested": "Approval has not been requested.",
    "No changes: the revision matches the base": "There are no changes from the original repository snapshot.",
    "Approval is for a different revision than the latest": "Approval was requested for an older code version.",
    "Evidence went stale after approval was requested": "Evidence became outdated after approval was requested.",
    "Approval cites no evidence": "The approval request does not refer to any evidence.",
    "Approval cites stale evidence": "The approval request refers to outdated evidence (from an older version).",
    "Approval cites unisolated evidence": "The approval request refers to results run without a protected environment.",
    "Approval cites evidence from another revision": "The approval request refers to evidence from another code version.",
    "No checks have run": "No tests or checks have run yet.",
    "A blocking finding is still open": "A finding that blocks approval is still open.",
  };
  if (fixed[reason]) return fixed[reason];
  if (reason.startsWith("Approval cites missing evidence:")) return reason.replace("Approval cites missing evidence:", "The approval request refers to missing events:");
  const check = [...checks].sort((a, b) => b.key.length - a.key.length).find((c) => reason.startsWith(`${c.key} `));
  if (!check) return reason;
  const prefix = checkLabel(check.key, check.kind);
  const singular = check.kind === "check" && prefix.startsWith("Registered check");
  const detail = reason.slice(check.key.length + 1);
  if (detail.startsWith("has not rerun on ")) return `${prefix} ${singular ? "has" : "have"} not been rerun on the requested version.`;
  if (detail === "ran without isolation") return `${prefix} ran without a protected environment.`;
  if (detail === "result is claimed, not observed") return `${prefix} ${singular ? "is agent-reported and has" : "are agent-reported and have"} not been verified.`;
  if (detail === "is stale") return `${prefix} ${singular ? "is" : "are"} outdated (an older version).`;
  return `${prefix}: ${humanize(detail)}.`;
}

export const EVENT_LABELS: Record<EventType, string> = {
  mission_started: "Mission started", plan: "Plan published", task_update: "Task updated", agent_msg: "Message",
  turn_start: "Turn started", turn_end: "Turn ended", tool_call: "Tool requested", tool_result: "Tool response",
  test_result: "Test result", finding: "Finding", diff: "Code version recorded",
  approval_needed: "Approval requested", approval_requested: "Approval requested", approval_result: "Decision recorded",
  escalation: "Needs your input", stale: "Evidence became outdated", mission_done: "Mission finished", usage: "Usage report",
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
