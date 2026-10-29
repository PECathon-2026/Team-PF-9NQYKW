import { describe, expect, test } from "bun:test";
import { agentRole, checkHelp, checkLabel, gateReason, HELP, MISSION_TABS, OUTDATED_LABEL, sourceHelp, sourceLabel, versionLabel, versionPhrase } from "./labels";
import { derive } from "./derive";
import { stockScript } from "./replay";
import { tabSummary } from "./summaries";
import type { MissionEvent } from "./types";

describe("plain-language labels", () => {
  test("names visible, hidden and other registered checks without exposing a raw identifier as the title", () => {
    expect(checkLabel("cheat.pytest", "check")).toBe("Visible tests (pytest)");
    expect(checkLabel("unit", "check")).toBe("Visible tests (unit)");
    expect(checkLabel("cheat.acceptance", "acceptance")).toBe("Hidden acceptance tests");
    expect(checkLabel("stock.lint", "check")).toBe("Registered check (Lint)");
    expect(checkHelp("cheat.acceptance", "acceptance")).toBe("DevPilot's private tests the agents never see.");
    expect(checkHelp("cheat.pytest", "check")).toBe(HELP.pytest);
    expect(checkHelp("unit", "check")).toBe(HELP.visibleTests);
  });

  test("describes known and unknown code versions while preserving the full hash separately", () => {
    expect(versionLabel("r2:sha256:2fd54f4c")).toBe("Version 2 of the change");
    expect(versionPhrase("r2:sha256:2fd54f4c")).toBe("version 2");
    expect(versionLabel("sha256:opaque")).toBe("Code version");
    expect(versionPhrase("sha256:opaque")).toBe("the current version");
    expect(versionLabel(null)).toBe("Not recorded yet");
  });

  test("makes provenance, outdated results, agent roles and tab descriptions understandable", () => {
    expect(sourceLabel(true)).toBe("Verified");
    expect(sourceHelp(true)).toContain("Observed by DevPilot itself");
    expect(sourceLabel(false)).toBe("Agent-reported");
    expect(sourceHelp(false)).toContain("not independently checked");
    expect(OUTDATED_LABEL).toBe("Outdated (older version)");
    expect(agentRole("shadow_review")).toBe("Reviews the code for problems");
    expect(agentRole("verifier")).toBe("Runs the hidden acceptance tests");
    expect(MISSION_TABS.map((tab) => tab.subtitle)).toEqual(["Summary & plan", "Test results & findings", "Code changes", "Full event log", "Your decision"]);
  });

  test("translates approval reasons without changing or dropping them", () => {
    const checks = [{ key: "cheat.pytest", kind: "check" as const }, { key: "cheat.acceptance", kind: "acceptance" as const }];
    expect(gateReason("A blocking finding is still open", checks)).toBe("A finding that blocks approval is still open.");
    expect(gateReason("Approval cites missing evidence: #42", checks)).toContain("missing events: #42");
    expect(gateReason("cheat.pytest result is claimed, not observed", checks)).toContain("Visible tests (pytest) are agent-reported");
    expect(gateReason("cheat.acceptance is stale", checks)).toContain("Hidden acceptance tests are outdated");
    expect(gateReason("cheat.pytest has not rerun on r2:sha256", checks)).toContain("have not been rerun on the requested version");
    expect(gateReason("stock.lint is stale", [{ key: "stock.lint", kind: "check" }])).toBe("Registered check (Lint) is outdated (an older version).");
    expect(gateReason("Unexpected server condition", checks)).toBe("Unexpected server condition");
  });
});

describe("mission tab summaries", () => {
  const events = stockScript("sim_stock", 1_000_000);

  test("summarizes the current version and resolved findings", () => {
    const view = derive(events);
    expect(tabSummary("evidence", view)).toBe("Both test suites passed on version 2; no findings are open.");
    expect(tabSummary("approval", view)).toContain("all approval requirements are met");
    expect(tabSummary("diff", view)).toContain("Version 2 of the change records 1 changed file");
  });

  test("does not present stale results as passing or confuse an advisory finding with a blocker", () => {
    const finding: MissionEvent = { ...events[13], id: 2000, payload: { finding_id: "new", action: "open", severity: "low", blocking: false, title: "Advisory" } };
    const beforeRerun = derive([...events.slice(0, 19).filter((event) => event.type !== "finding"), finding]);
    expect(tabSummary("evidence", beforeRerun)).toBe("No test results are recorded for the latest version yet; 1 finding is still open.");
    const blocking = derive([...events, { ...finding, payload: { ...finding.payload, blocking: true } }]);
    expect(tabSummary("evidence", blocking)).toContain("1 finding is still open and blocking approval");
    expect(tabSummary("approval", blocking)).toContain("approval is blocked");
  });

  test("distinguishes a reported pass from a verified test result", () => {
    const unverified = events.map((event) => event.id === events[20].id ? { ...event, verified: false } : event);
    expect(tabSummary("evidence", derive(unverified))).toContain("Both test suites were reported as passed on version 2");
  });
});
