// DEV-ONLY simulated event stream. Every event conforms to the contract envelope.
import { isEvent, type Agent, type EventType, type MissionEvent } from "./types";
import { REQUESTS } from "./requests";

type Draft = [EventType, Agent, string | null, string | null, boolean, Record<string, unknown>];
const B = "sha256:base0000simulated"; const R1 = "r1:sha256:sim1a2b"; const R2 = "r2:sha256:sim3c4d";

function build(mission: string, drafts: Draft[], t0: number): MissionEvent[] {
  return drafts.map(([type, agent, task_id, code_rev, verified, payload], i) => ({ id: 1001 + i * 3, ts: t0 + i * 1400, mission_id: mission, type, agent, task_id, code_rev, verified, payload: type === "usage" ? payload : { ...payload, isolation: "isolated" } }));
}
// Event ids are 1001 + 3*index; helpers reference earlier events by index.
const E = (i: number) => 1001 + i * 3;
const U = (t: number, i: number, o: number) => ({ turns: t, input_tokens: i, output_tokens: o });
const BUDGET = { shogun: 6, samurai: 10, shadow_review: 8, shadow_security: 8 };
const usage = (per_agent: Record<string, ReturnType<typeof U>>): Draft => {
  const v = Object.values(per_agent);
  return ["usage", "system", null, null, true, { per_agent, budget: BUDGET, total: U(v.reduce((a, x) => a + x.turns, 0), v.reduce((a, x) => a + x.input_tokens, 0), v.reduce((a, x) => a + x.output_tokens, 0)) }];
};

export function stockScript(mission: string, t0: number): MissionEvent[] {
  const d: Draft[] = [
    /*0*/ ["mission_started","orchestrator",null,null,true,{ repo:"stock", request:REQUESTS.stock, base_hash:B, deadline:t0+150000, suite_id:"stock-acceptance", mode:"multi", baseline_of:null, paired_mission_id:null }],
    /*1*/ ["tool_call","shogun",null,null,true,{ call_id:"c1", tool:"run_check", arguments:{ check_id:"unit" }, job_id:"j1" }],
    /*2*/ ["tool_result","system",null,null,true,{ call_id:"c1", ok:true, artifact_id:"a1", data:{ stdout:"1 failed, 6 passed" } }],
    /*3*/ ["test_result","sentinel",null,null,true,{ check_id:"unit", outcome:"failed", phase:"baseline", exit_code:1, duration:820, artifact_id:"a1", cause_event_ids:[] }],
    /*4*/ ["plan","shogun",null,null,false,{ version:1, reason_event_ids:[E(3)], criteria:["reserve(qty, available) accepts qty == available","Existing checks keep passing"],
            tasks:[{ id:"t_fix", title:"Fix boundary comparison in reserve()", role:"samurai", status:"ready", deps:[] },{ id:"t_eval", title:"Run checks + acceptance on sealed revision", role:"sentinel", status:"pending", deps:["t_fix"] },{ id:"t_review", title:"Review and security pass", role:"shadow_review", status:"pending", deps:["t_fix"] }] }],
    /*5*/ ["agent_msg","shogun","t_fix",null,false,{ to:"samurai", message:"Baseline shows reserve(5,5) rejected. Likely `qty < available` should be `<=`. See failing test.", evidence_event_ids:[E(3)] }],
    /*6*/ ["task_update","orchestrator","t_fix",null,true,{ task_id:"t_fix", previous_status:"ready", status:"running", reason_event_ids:[E(5)] }],
    /*7*/ ["tool_call","samurai","t_fix",null,true,{ call_id:"c2", tool:"apply_patch", arguments:{ path:"stock.py" }, job_id:"j2" }],
    /*8*/ ["tool_result","system","t_fix",R1,true,{ call_id:"c2", ok:true, data:{ path:"stock.py", changed:true } }],
    /*9*/ ["diff","samurai","t_fix",R1,true,{ base_hash:B, revision:R1, changed_paths:["stock.py"], artifact_id:"a2",
            text:"--- a/stock.py\n+++ b/stock.py\n@@ -8,5 +8,5 @@ def reserve(qty, available):\n     if qty <= 0:\n         return False\n-    return qty < available\n+    return qty <= available\n" }],
    /*10*/ ["task_update","orchestrator","t_fix",R1,true,{ task_id:"t_fix", previous_status:"running", status:"done", reason_event_ids:[E(9)] }],
    /*11*/ ["test_result","sentinel","t_eval",R1,true,{ check_id:"unit", outcome:"passed", revision:R1, exit_code:0, duration:790, artifact_id:"a3", cause_event_ids:[E(9)] }],
    /*12*/ ["test_result","verifier","t_eval",R1,true,{ suite_id:"stock-acceptance", outcome:"passed", revision:R1, exit_code:0, duration:1210, artifact_id:"a4", cause_event_ids:[E(9)] }],
    /*13*/ ["finding","shadow_review","t_review",R1,false,{ finding_id:"F1", action:"sent_back", severity:"medium", blocking:true, title:"Negative available accepted", detail:"reserve() does not reject a negative `available` value.", evidence_ids:[E(9)] }],
    /*14*/ ["agent_msg","orchestrator","t_fix",R1,false,{ to:"samurai", message:"Repair F1: reject available < 0.", evidence_event_ids:[E(13)] }],
    /*15*/ ["task_update","orchestrator","t_fix",R1,true,{ task_id:"t_fix", previous_status:"done", status:"running", reason_event_ids:[E(13)] }],
    /*16*/ ["tool_call","samurai","t_fix",R1,true,{ call_id:"c3", tool:"apply_patch", arguments:{ path:"stock.py" }, job_id:"j3" }],
    /*17*/ ["stale","system","t_fix",R1,true,{ old_revision:R1, new_revision:R2, invalidated:[E(11),E(12),E(13)], affected_evidence_ids:[E(11),E(12),E(13)], reason:"content-changing edit to stock.py" }],
    /*18*/ ["diff","samurai","t_fix",R2,true,{ base_hash:B, revision:R2, changed_paths:["stock.py"], artifact_id:"a5",
            text:"--- a/stock.py\n+++ b/stock.py\n@@ -6,7 +6,9 @@ def reserve(qty, available):\n     if qty <= 0:\n         return False\n-    return qty < available\n+    if available < 0:\n+        return False\n+    return qty <= available\n" }],
    /*19*/ ["task_update","orchestrator","t_fix",R2,true,{ task_id:"t_fix", previous_status:"running", status:"done", reason_event_ids:[E(18)] }],
    /*20*/ ["test_result","sentinel","t_eval",R2,true,{ check_id:"unit", outcome:"passed", revision:R2, exit_code:0, duration:770, artifact_id:"a6", cause_event_ids:[E(18)] }],
    /*21*/ ["test_result","verifier","t_eval",R2,true,{ suite_id:"stock-acceptance", outcome:"passed", revision:R2, exit_code:0, duration:1190, artifact_id:"a7", cause_event_ids:[E(18)] }],
    /*22*/ ["tool_result","shadow_security","t_review",R2,true,{ call_id:"c4", ok:true, data:{ scanner_findings:0 }, artifact_id:"a8" }],
    /*23*/ ["finding","shadow_review","t_review",R2,false,{ finding_id:"F1", action:"resolve", severity:"medium", blocking:true, title:"Negative available accepted", detail:"Guard added; acceptance rerun passed.", evidence_ids:[E(18),E(21)] }],
    /*24*/ ["task_update","orchestrator","t_eval",R2,true,{ task_id:"t_eval", previous_status:"pending", status:"done", reason_event_ids:[E(20),E(21)] }],
    /*25*/ ["task_update","orchestrator","t_review",R2,true,{ task_id:"t_review", previous_status:"pending", status:"done", reason_event_ids:[E(22),E(23)] }],
    /*26*/ usage({ shogun: U(3, 9120, 1480), samurai: U(4, 15230, 2110), shadow_review: U(2, 6400, 720), shadow_security: U(1, 3900, 310) }),
    /*27*/ ["approval_needed","orchestrator",null,R2,true,{ approval_id:"ap1", evidence_ids:[E(20),E(21),E(22),E(23)], tree_hash:"tree3c4d", decision:null }],
  ];
  return build(mission, d, t0);
}
export function titlesScript(mission: string, t0: number): MissionEvent[] {
  const d: Draft[] = [
    ["mission_started","orchestrator",null,null,true,{ repo:"titles", request:REQUESTS.titles, base_hash:B, deadline:t0+150000, suite_id:null, mode:"multi", baseline_of:null, paired_mission_id:null }],
    ["tool_call","shogun",null,null,true,{ call_id:"c1", tool:"search", arguments:{ query:"title style guide" }, job_id:"j1" }],
    ["tool_result","system",null,null,true,{ call_id:"c1", ok:false, error:{ code:"TOOL_DISABLED" } }],
    ["agent_msg","shogun",null,null,false,{ to:"orchestrator", message:"\"Clean up\" could mean casing, trimming, or deduplication. No matching acceptance suite.", evidence_event_ids:[E(2)] }],
    usage({ shogun: U(2, 4100, 520) }),
    ["escalation","orchestrator",null,null,true,{ reason:"Ambiguous request; no registered acceptance suite", question:"Which cleanup do you want: title-case, whitespace trimming, or removing duplicates?", relevant_event_ids:[E(2),E(3)] }],
    ["mission_done","orchestrator",null,null,true,{ status:"ESCALATED", applied_revision:null, evidence_ids:[E(2),E(5)], unresolved_findings:[], baseline_of:null, paired_mission_id:null }],
  ];
  return build(mission, d, t0);
}
export function decisionEvents(mission: string, lastId: number, rev: string, approved: boolean): MissionEvent[] {
  const now = Date.now();
  return [
    { id: lastId + 3, ts: now, mission_id: mission, type: "approval_result", agent: "human", task_id: null, code_rev: rev, verified: true, payload: { approval_id: "ap1", evidence_ids: [], tree_hash: "tree3c4d", decision: approved, isolation: "isolated" } },
    { id: lastId + 6, ts: now + 600, mission_id: mission, type: "mission_done", agent: "orchestrator", task_id: null, code_rev: rev, verified: true, payload: { status: approved ? "COMPLETED" : "REJECTED", ...(approved ? { applied_revision: rev } : {}), evidence_ids: [lastId + 3], unresolved_findings: [], baseline_of: null, paired_mission_id: null, isolation: "isolated" } },
  ];
}
export function assertValid(evs: MissionEvent[]) { evs.forEach((e) => { if (!isEvent(e)) throw new Error(`invalid replay event ${JSON.stringify(e)}`); }); return evs; }
