import { approved, blocksGate, col, isOpen, str, type View } from "./derive";
import { checkLabel, eventLabel, plural, stateLabel, versionLabel, versionPhrase, type MissionTab } from "./labels";

/** Summaries describe only recorded results; they do not decide whether approval is allowed. */
export function tabSummary(tab: MissionTab, v: View): string {
  const open = v.findings.filter(isOpen).length;
  const blocked = v.findings.some(blocksGate);
  const findings = open === 0 ? "no findings are open" : `${plural(open, "finding")} ${open === 1 ? "is" : "are"} still open${blocked ? " and blocking approval" : ""}`;
  switch (tab) {
    case "overview": {
      const done = v.tasks.filter((task) => col(task.status) === "done").length;
      return `${stateLabel(v.state)}; ${done} of ${v.tasks.length} planned tasks are done and ${findings}.`;
    }
    case "evidence": {
      const current = v.currentRev ? v.checks.filter((check) => check.code_rev === v.currentRev && !check.stale) : [];
      let tests = "No test results are recorded for the latest version yet";
      if (current.length) {
        const passed = current.filter((check) => check.outcome === "passed").length;
        const bothSuites = current.length === 2 && current.some((check) => check.kind === "acceptance") && current.some((check) => checkLabel(check.key, check.kind).startsWith("Visible tests"));
        const unverified = current.some((check) => !check.event.verified);
        const count = passed === current.length
          ? `${bothSuites ? "Both test suites" : plural(passed, "test or check")} ${unverified ? `${current.length === 1 ? "was" : "were"} reported as passed` : "passed"}`
          : `${passed} of ${current.length} tests or checks ${unverified ? "were reported as passed" : "passed"}`;
        tests = `${count} on ${versionPhrase(v.currentRev)}`;
      }
      return `${tests}; ${findings}${v.pendingApproval && !v.approvalResult && !v.gate.ok && !blocked ? ", and approval is blocked by other requirements" : ""}.`;
    }
    case "diff": {
      const latest = v.diffs[v.diffs.length - 1];
      if (!latest) return "No code changes have been recorded yet.";
      const paths = Array.isArray(latest.payload.changed_paths) ? latest.payload.changed_paths.length : null;
      return `${versionLabel(latest.code_rev ?? str(latest.payload.revision))} ${paths === null ? "has been recorded" : `records ${plural(paths, "changed file")} in its latest edit`}, with the code below compared against the original repository snapshot.`;
    }
    case "activity": {
      const latest = v.events[v.events.length - 1];
      return latest ? `${plural(v.events.length, "event")} recorded; the latest is ${eventLabel(latest.type).toLowerCase()}.` : "No events have been recorded yet.";
    }
    case "approval":
      if (v.approvalResult) return `Your decision was recorded as ${approved(v.approvalResult) ? "approved" : "rejected"} for ${versionPhrase(v.approvalResult.code_rev ?? v.pendingApproval?.code_rev)}.`;
      if (v.pendingApproval && v.done) return `The mission has finished; no decision is available for ${versionPhrase(v.pendingApproval.code_rev)}.`;
      if (v.pendingApproval) return `Your decision is requested for ${versionPhrase(v.pendingApproval.code_rev)}; ${v.gate.ok ? "all approval requirements are met" : "approval is blocked until the requirements below are met"}.`;
      return "No approval has been requested yet; your decision will appear here if one is needed.";
  }
}
