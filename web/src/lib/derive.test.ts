import { describe, expect, test } from "bun:test";
import { stageState } from "./derive";
import type { Agent, EventType, MissionEvent } from "./types";

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
