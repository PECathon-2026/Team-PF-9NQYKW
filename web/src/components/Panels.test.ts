import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "../lib/derive";
import { stockScript } from "../lib/replay";
import type { MissionEvent } from "../lib/types";
import { Approval, Evidence, Header, Timeline } from "./Panels";

const events = stockScript("sim_stock", 1_000_000);
const longText = `The full review message ${"continues-without-truncation-".repeat(80)}end of finding.`;
const longPath = `tests/${"deep-directory/".repeat(25)}test_protected.py`;
const findings: MissionEvent[] = [
  { ...events[13], id: 2000, payload: { finding_id: "F-long", action: "open", severity: "high", blocking: true, title: "Review issue", detail: longText } },
  { ...events[13], id: 2001, agent: "orchestrator", verified: true, payload: { finding_id: "F-tamper", action: "open", severity: "info", blocking: false, title: "Protected file edit blocked", tamper: { tool: "edit_file", path: longPath, code: "PROTECTED_FILE" }, evidence_event_ids: [events[7].id] } },
];

describe("mission results presentation", () => {
  test("labels the mission header and makes the full version and mission ID available without a Live indicator", () => {
    const html = renderToStaticMarkup(createElement(Header, { v: derive(events), mode: "live", conn: "live", now: 1_100_000, missionId: "sim_stock", repo: "stock" }));
    for (const label of ["Repository", "Request", "Status", "Time left", "Fix rounds used", "Model turns", "Tokens", "Code version", "Mission ID"]) expect(html).toContain(label);
    expect(html).toContain("Version 2 of the change");
    expect(html).toContain("r2:sha256:sim3c4d");
    expect(html).toContain("sim_stock");
    expect(html).not.toContain(">Live<");
  });

  test("shows the full findings, tamper paths and clickable supporting event IDs", () => {
    const html = renderToStaticMarkup(createElement(Evidence, { v: derive([...events, ...findings]), onCite: () => {} }));
    expect(html).toContain(longText);
    expect(html).toContain(longPath);
    expect(html).toContain("PROTECTED_FILE");
    expect(html).toContain("Agent-reported");
    expect(html).toContain("Verified");
    expect(html).toContain('title="Show this event in the Full event log"');
  });

  test("keeps full event messages readable in the log and exposes the event details", () => {
    const message: MissionEvent = { ...events[5], id: 3000, payload: { to: "samurai", message: longText, evidence_event_ids: [events[3].id] } };
    const html = renderToStaticMarkup(createElement(Timeline, { v: derive([...events, message]), filter: "all", setFilter: () => {}, onCite: () => {} }));
    expect(html).toContain(longText);
    expect(html).toContain("Show full event details");
    expect(html).toContain('title="Show this event in the Full event log"');
  });

  test("preserves the approval gate when findings block the decision", () => {
    const ready = renderToStaticMarkup(createElement(Approval, { v: derive(events), onDecide: () => {}, busy: false, error: "", onCite: () => {} }));
    const blocked = renderToStaticMarkup(createElement(Approval, { v: derive([...events, ...findings]), onDecide: () => {}, busy: false, error: "", onCite: () => {} }));
    expect(ready).not.toMatch(/class="primary" disabled/);
    expect(blocked).toMatch(/class="primary" disabled/);
    expect(blocked).toContain("A finding that blocks approval is still open.");
    expect(blocked).toContain("Snapshot of the changed files");
  });
});
