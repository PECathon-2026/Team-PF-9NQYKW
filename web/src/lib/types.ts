// Event envelope per ARCHITECTURE.md "Message bus and event contract".
export const AGENTS = ["orchestrator","shogun","samurai","sentinel","verifier","shadow_review","shadow_security","baseline","human","system"] as const;
export type Agent = (typeof AGENTS)[number];
export const EVENT_TYPES = ["mission_started","plan","task_update","agent_msg","turn_start","turn_end","tool_call","tool_result","test_result","finding","diff","approval_needed","approval_requested","approval_result","escalation","stale","mission_done","usage"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface MissionEvent {
  id: number; ts: number; mission_id: string; type: EventType; agent: Agent;
  task_id: string | null; code_rev: string | null; verified: boolean;
  payload: Record<string, unknown>;
  /** Present as "unisolated" on events from a run without sandbox isolation (may also appear in payload). */
  isolation?: string;
}
export interface UsageCount { turns: number; input_tokens: number; output_tokens: number }
const isCount = (c: unknown): c is UsageCount => { const o = c as UsageCount; return !!o && [o.turns, o.input_tokens, o.output_tokens].every((n) => typeof n === "number" && n >= 0); };
/** Optional per-role turn budget: {<agent>: non-negative integer}. */
export const isBudget = (b: unknown): b is Record<string, number> => typeof b === "object" && b !== null && !Array.isArray(b)
  && Object.entries(b as object).every(([k, n]) => (AGENTS as readonly string[]).includes(k) && Number.isInteger(n) && n >= 0);
/** usage payload: cumulative {per_agent: {<agent>: UsageCount}, total: UsageCount, budget?: {<agent>: n}, pass_turns?: {<agent>: n}} (pass_turns is top-level). */
export const isUsagePayload = (p: Record<string, unknown>) => isCount(p.total) && typeof p.per_agent === "object" && p.per_agent !== null
  && Object.entries(p.per_agent as object).every(([k, v]) => (AGENTS as readonly string[]).includes(k) && isCount(v))
  && (p.budget === undefined || isBudget(p.budget));
export const isUnisolated = (e: MissionEvent) => e.isolation === "unisolated" || e.payload.isolation === "unisolated";
export const isEvent = (x: unknown): x is MissionEvent => {
  const e = x as MissionEvent;
  return !!e && typeof e.id === "number" && typeof e.ts === "number" && typeof e.mission_id === "string"
    && (EVENT_TYPES as readonly string[]).includes(e.type) && (AGENTS as readonly string[]).includes(e.agent)
    && (e.task_id === null || typeof e.task_id === "string") && (e.code_rev === null || typeof e.code_rev === "string")
    && typeof e.verified === "boolean" && typeof e.payload === "object" && e.payload !== null
    && (e.isolation === undefined || typeof e.isolation === "string")
    && (e.type !== "usage" || isUsagePayload(e.payload));
};
export const REPOS = ["cart","stats","stock","notes","titles"] as const;
export type RepoId = (typeof REPOS)[number];
