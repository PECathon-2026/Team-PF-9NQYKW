import { useEffect, useState } from "react";
import type { MissionEvent } from "../lib/types";
import { agentTurns, approved, buildPatch, col, isResolved, revisionDiffs, secondsLeft, short, str, type View } from "../lib/derive";
import { CONNECTION, agentName, eventLabel, humanize, plural, stateLabel } from "../lib/labels";

// All dynamic text is rendered as React text nodes (never innerHTML).
export const Prov = ({ e, stale, unisolated }: { e: { verified: boolean }; stale?: boolean; unisolated?: boolean }) => (
  <span className="prov">
    {unisolated && <span className="tag uniso" title="Ran without sandbox isolation. Never counts toward approval.">unisolated</span>}
    <span className={e.verified ? "tag ok" : "tag claim"} title={e.verified ? "Observed by the service or a trusted runner" : "Reported by a model, not observed"}>{e.verified ? "verified" : "claimed"}</span>
    {stale && <span className="tag stale" title="Invalidated by a later revision">stale</span>}
  </span>
);
export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const COLUMNS: Record<string, string> = { pending: "Pending", ready: "Ready", running: "Running", blocked: "Blocked", done: "Done" };

export function Header({ v, mode, conn, now }: { v: View; mode: string; conn: string; now: number }) {
  const clockLeft = secondsLeft(v, v.done?.ts ?? now); const left = clockLeft?.left ?? null;
  const terminal = !!v.done || v.state === "ESCALATED" || v.state === "REJECTED";
  const endTs = v.done?.ts ?? v.events[v.events.length - 1]?.ts;
  const wall = Number(v.done?.payload.wall_elapsed_ms);
  const took = terminal && v.started && endTs ? Math.max(0, Math.round((Number.isFinite(wall) && wall > 0 ? wall : endTs - v.started.ts) / 1000)) : null;
  return (
    <header className="mhead">
      <div>
        <div className="mission-meta"><span>{str(v.started?.payload.repo, "—")}</span><span className="mono">{v.started?.mission_id ?? ""}</span></div>
        <div className="req">{str(v.started?.payload.request)}</div>
      </div>
      <div className="hstats">
        <span className={`state s-${v.state.toLowerCase()}`}>{stateLabel(v.state)}</span>
        <span className="muted" title={v.currentRev ?? undefined}>Revision <code>{short(v.currentRev)}</code></span>
        {took !== null ? <span className="muted" title="Total mission duration">Finished in {clock(took)}</span> : left !== null && <span className={left < 30 && !clockLeft?.paused ? "warn" : "muted"} title={clockLeft?.paused ? "The deadline is paused while approval is pending" : "Time left before the mission deadline, including any extensions"}>{clock(left)} left{clockLeft?.paused ? " · paused" : ""}</span>}
        <span className="muted">Fix cycles {v.fixCycles}/3</span>
        {v.usage && <span className="muted" title={Object.entries(v.usage.per_agent).map(([a, u]) => { const used = agentTurns(v.usage, a) ?? u.turns; const cap = v.budget?.[a]; return `${agentName(a)}: ${used}${cap !== undefined && used <= cap ? `/${cap}` : ""} turns, ${fmtTok(u.input_tokens + u.output_tokens)} tokens`; }).join("\n")}>{plural(v.usage.total.turns, "turn")} · {fmtTok(v.usage.total.input_tokens + v.usage.total.output_tokens)} tokens</span>}
        {v.unisolated.size > 0 && <span className="tag uniso" title="This runner has no sandbox isolation. Its results cannot satisfy the approval gate.">unisolated runner</span>}
        <span className={`conn conn-${mode === "replay" ? "simulated" : conn}`}>{mode === "replay" ? "Simulated" : CONNECTION[conn] ?? humanize(conn)}</span>
      </div>
    </header>
  );
}

export function Escalation({ v }: { v: View }) {
  if (!v.escalations.length) return null;
  const e = v.escalations[v.escalations.length - 1];
  return (
    <div className="banner">
      <strong>Escalated to you.</strong> <span title={str(e.payload.reason)}>{humanize(str(e.payload.reason))}</span>
      {(e.payload.question || e.payload.action) ? <div className="q">{str(e.payload.question ?? e.payload.action)}</div> : null}
      {(() => { const ids = Array.isArray(e.payload.relevant_event_ids) ? e.payload.relevant_event_ids : Array.isArray(e.payload.event_ids) ? e.payload.event_ids : []; return <div className="muted small">{[ids.length ? `Related events ${ids.map((i) => `#${i}`).join(" ")}` : "", e.payload.reason === "AMBIGUOUS_REQUEST" ? "Start a new mission with a clearer request." : ""].filter(Boolean).join(" · ")}</div>; })()}
    </div>
  );
}

export function TaskBoard({ v }: { v: View }) {
  const cols = ["pending", "ready", "running", "blocked", "done"];
  const crit = Array.isArray(v.plan?.payload.criteria) ? (v.plan!.payload.criteria as unknown[]) : [];
  return (
    <section className="card scroll" key={v.plan?.id ?? 0}>
      <h3>Plan {v.plan && <span className="h-meta">Version {str(v.plan.payload.version)}</span>} {v.plan && <Prov e={v.plan} />}</h3>
      {crit.length > 0 && <ul className="crit">{crit.map((c, i) => <li key={i}>{typeof c === "object" && c ? `${str((c as Record<string, unknown>).id)}: ${str((c as Record<string, unknown>).description)}` : str(c)}</li>)}</ul>}
      {!v.plan && <p className="muted">No plan yet.</p>}
      <div className="board">
        {cols.map((c) => (
          <div key={c} className={`col col-${c}${v.tasks.some((t) => col(t.status) === c) ? "" : " empty"}`}>
            <div className="colh">{COLUMNS[c]}</div>
            {!v.tasks.some((t) => col(t.status) === c) && <span className="empty-dash" aria-label="No tasks">—</span>}
            {v.tasks.filter((t) => col(t.status) === c).map((t) => (
              <div key={t.id} className="task" title={t.id}><div>{t.title}</div><div className="muted small">{t.role ? agentName(t.role) : ""}{t.deps.length ? `${t.role ? " · " : ""}After ${t.deps.map((d) => `“${v.tasks.find((x) => x.id === d)?.title ?? d}”`).join(", ")}` : ""}</div></div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

// Only show the unisolated tag where a runner actually executed something.
const RUN_TYPES = new Set(["test_result", "tool_result"]);
export function Timeline({ v, filter, setFilter }: { v: View; filter: string; setFilter: (filter: string) => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const agents = Array.from(new Set(["all", ...(filter !== "all" ? [filter] : []), ...v.events.map((e) => e.agent)]));
  const list = v.events.filter((e) => filter === "all" || e.agent === filter);
  const selected = list.find((e) => e.id === selectedId) ?? list[list.length - 1];
  const start = list.length ? Math.min(...list.map((e) => e.ts)) : 0;
  const end = list.length ? Math.max(...list.map((e) => e.ts)) : 0;
  const duration = end - start;
  const lanes = Array.from(new Set(list.map((e) => e.agent)));
  return (
    <section className="card tl">
      <h3>Activity
        <select aria-label="Filter by agent" value={filter} onChange={(e) => setFilter(e.target.value)}>{agents.map((a) => <option key={a} value={a}>{a === "all" ? "All agents" : agentName(a)}</option>)}</select>
      </h3>
      <div className="trace-layout">
        <div className="trace" aria-label="Event trace">
          {list.length ? <>
            <div className="trace-axis"><span>Agent</span><div><span>{time(start)}</span><span>{duration ? time(start + duration / 2) : ""}</span><span>{duration ? time(end) : ""}</span></div></div>
            {lanes.map((agent) => <div className="trace-lane" key={agent}><span className="trace-agent">{agentName(agent)}</span><div className="trace-track">{list.filter((e) => e.agent === agent).map((e) => <button type="button" key={e.id} className={`trace-event ${e.type === "agent_msg" ? "message" : ""} ${selected?.id === e.id ? "selected" : ""}`} style={{ left: `${duration ? ((e.ts - start) / duration) * 100 : 50}%` }} onClick={() => setSelectedId(e.id)} aria-label={`${eventLabel(e.type)}, #${e.id}, ${time(e.ts)}`} aria-pressed={selected?.id === e.id} title={`${eventLabel(e.type)} · #${e.id}${summary(e) ? `\n${summary(e)}` : ""}`} />)}</div></div>)}
          </> : <p className="muted trace-empty">No activity from this agent yet.</p>}
        </div>
        {selected && <aside className="trace-detail" aria-label="Selected event">
          <div className="trace-detail-heading"><strong title={selected.type}>{eventLabel(selected.type)}</strong><span className="mono muted">#{selected.id}</span></div><div className="trace-detail-meta">{agentName(selected.agent)} · <span className="num">{time(selected.ts)}</span> <Prov e={selected} stale={v.staleIds.has(selected.id)} unisolated={RUN_TYPES.has(selected.type) && v.unisolated.has(selected.id)} /></div><div className="esum">{summary(selected)}</div>
        </aside>}
      </div>
      <div className="log-label">Event log{filter !== "all" && <span>{list.length}</span>}</div>
      <ol className="events">
        {list.map((e) => (
          <li key={e.id} className={v.staleIds.has(e.id) ? "is-stale" : ""}>
            <span className="muted mono">#{e.id} {time(e.ts)}</span>
            <span className={`agent a-${e.agent}`} title={e.agent}>{agentName(e.agent)}</span>
            <span className="etype" title={e.type}>{eventLabel(e.type)}</span>
            <Prov e={e} stale={v.staleIds.has(e.id)} unisolated={RUN_TYPES.has(e.type) && v.unisolated.has(e.id)} />
            {summary(e) && <div className="esum">{summary(e)}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}
export function summary(e: MissionEvent): string {
  const p = e.payload;
  const cite = (k: string) => (Array.isArray(p[k]) && (p[k] as unknown[]).length ? `  ← ${(p[k] as unknown[]).map((x) => `#${x}`).join(" ")}` : "");
  switch (e.type) {
    case "mission_started": return `${str(p.repo)} at base ${short(str(p.base_hash))}`;
    case "plan": return `Version ${str(p.version)} · ${plural(Array.isArray(p.tasks) ? p.tasks.length : 0, "task")}${cite("reason_event_ids")}`;
    case "task_update": return `${str(p.task_id)}: ${str(p.previous_status)} → ${str(p.new_status ?? p.status)}${cite("reason_event_ids")}`;
    case "agent_msg": return `To ${agentName(str(p.to ?? p.recipient))}: ${str(p.message)}${Array.isArray(p.findings) ? ` · ${plural(p.findings.length, "finding")}` : ""}${typeof p.scanner_findings === "number" ? ` · ${plural(p.scanner_findings, "scanner finding")}` : ""}${cite("evidence_event_ids")}${cite("cited_event_ids")}`;
    case "turn_start": case "turn_end": return "";
    case "tool_call": return `${str(p.tool)}(${JSON.stringify(p.arguments ?? p.args ?? {})})`;
    case "tool_result": { if (p.ok === false) return `Error ${str((p.error as Record<string, unknown> | undefined)?.code ?? p.error, "unknown")}`; const d = p.data as Record<string, unknown> | undefined; const s = d ? (typeof d.content === "string" ? d.content : JSON.stringify(d)) : str(p.result, "ok"); return s; }
    case "test_result": { const cr = Array.isArray(p.criteria) ? (p.criteria as { passed?: boolean }[]) : null; return `${p.phase === "baseline" ? "Baseline · " : ""}${str(p.suite_id ?? p.check_id)} ${str(p.outcome)}${p.exit_code !== undefined ? ` (exit ${str(p.exit_code)})` : ""}${cr ? ` · ${cr.filter((c) => c.passed).length}/${cr.length} criteria` : ""}${cite("cause_event_ids")}`; }
    case "finding": return `${str(p.finding_id)} ${isResolved(str(p.action)) ? "resolved" : humanize(str(p.action)).toLowerCase()} · ${str(p.severity)} · ${str(p.title ?? p.description ?? p.resolution)}${cite("evidence_event_ids")}`;
    case "diff": return `${short(str(p.revision))}: ${Array.isArray(p.changed_paths) ? p.changed_paths.join(", ") : ""}`;
    case "approval_needed": case "approval_requested": return `Revision ${short(e.code_rev)}${cite("evidence_ids")}`;
    case "approval_result": return approved(e) ? "Approved" : "Rejected";
    case "escalation": return `${humanize(str(p.reason))}: ${str(p.question)}${cite("relevant_event_ids")}`;
    case "stale": { const inv = p.affected_evidence_ids ?? p.invalidated; return `${short(str(p.old_revision))} → ${short(str(p.new_revision))}: ${str(p.reason)} · invalidated ${Array.isArray(inv) ? inv.map((x) => `#${x}`).join(" ") : ""}`; }
    case "mission_done": return stateLabel(str(p.status));
    case "usage": { const t = p.total as { turns: number; input_tokens: number; output_tokens: number }; return `${plural(t.turns, "turn")} · ${fmtTok(t.input_tokens)} in / ${fmtTok(t.output_tokens)} out tokens`; }
  }
}

export function Evidence({ v }: { v: View }) {
  return (
    <section className="card">
      <h3>Evidence</h3>
      <table className="tbl">
        <thead><tr><th>Check</th><th>Outcome</th><th>Attempts</th><th>Revision</th><th>Source</th></tr></thead>
        <tbody>
          {v.checks.length === 0 && <tr><td colSpan={5} className="muted">No checks have run yet.</td></tr>}
          {v.checks.map((c) => (
            <tr key={c.key} className={c.stale ? "is-stale" : ""}>
              <td><span className="mono">{c.key}</span><div className="muted small">{c.kind === "acceptance" ? "Acceptance suite" : "Project check"}</div></td>
              <td key={c.event.id} className={c.outcome === "passed" ? "pass cut" : "fail"}>{cap(c.outcome)}{c.exit !== undefined ? ` · exit ${c.exit}` : ""}{Array.isArray(c.event.payload.criteria) ? <div className="muted small">{(c.event.payload.criteria as { passed?: boolean }[]).filter((x) => x.passed).length}/{(c.event.payload.criteria as unknown[]).length} criteria</div> : null}{c.duration !== undefined ? <div className="muted small">{c.duration} ms</div> : null}</td>
              <td>{c.attempts}</td>
              <td><code title={c.code_rev ?? undefined}>{short(c.code_rev)}</code> <span className="muted small mono">#{c.event.id}</span></td>
              <td><Prov e={c.event} stale={c.stale} unisolated={v.unisolated.has(c.event.id)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Findings</h4>
      {v.findings.length === 0 && <p className="muted">No findings. A clean review is a model conclusion, not proof.</p>}
      {v.findings.map((f) => (
        <div key={f.id} className={`finding ${f.stale ? "is-stale" : ""}`}>
          <span className={`sev sev-${f.severity}`}>{f.severity}</span>
          <strong className="mono">{f.id}</strong> <span className="muted">{agentName(f.agent)}{f.blocking ? " · Blocking" : ""}</span>
          <span key={f.action} className={isResolved(f.action) ? "pass cut" : "warn"}> · {isResolved(f.action) ? "Resolved" : "Open"}</span>
          {f.sentBack && <span className="tag back">sent back to Samurai</span>}
          <Prov e={f} stale={f.stale} unisolated={v.unisolated.has(f.eventId)} />
          <div>{f.description}</div>
          {f.resolution && <div className="muted small">Resolution: {f.resolution}</div>}
        </div>
      ))}
    </section>
  );
}

export function DiffViewer({ v, fetchArtifact }: { v: View; fetchArtifact?: (id: string) => Promise<string> }) {
  const [idx, setIdx] = useState(-1);
  const d = v.diffs[idx < 0 ? v.diffs.length - 1 : idx];
  const [text, setText] = useState("");
  useEffect(() => {
    if (!d) return setText("");
    if (typeof d.payload.text === "string") return setText(d.payload.text);
    const a = str(d.payload.artifact_id ?? d.payload.diff_artifact_id);
    if (a && fetchArtifact) fetchArtifact(a).then(setText, (err) => setText(`Could not load the diff (artifact ${a}): ${err instanceof Error ? err.message : String(err)}`));
  }, [d, fetchArtifact]);
  return (
    <section className="card">
      <h3>Diff
        {v.diffs.length > 1 && <select aria-label="Revision" value={idx < 0 ? v.diffs.length - 1 : idx} onChange={(e) => setIdx(Number(e.target.value))}>
          {v.diffs.map((x, i) => <option key={x.id} value={i}>{short(x.code_rev)}{i === v.diffs.length - 1 ? " (latest)" : ""}</option>)}</select>}
      </h3>
      {!d ? <p className="muted">No revision yet.</p> : (
        <>
          <div className="muted small">Base <code>{short(str(d.payload.base_hash))}</code> → <code>{short(d.code_rev)}</code> · {(d.payload.changed_paths as string[] | undefined)?.join(", ")}</div>
          <pre className="diff">{text.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l || " "}</div>)}</pre>
        </>
      )}
    </section>
  );
}

export function Approval({ v, onDecide, busy, error }: { v: View; onDecide: (a: boolean) => void; busy: boolean; error: string }) {
  const a = v.pendingApproval;
  if (!a && !v.approvalResult) return null;
  return (
    <section className={`card approval ${approved(v.approvalResult) ? "sealed" : ""}`}>
      <h3>Approval</h3>
      {a && <div className="kv">
        <span>Revision</span><code>{a.code_rev ?? str(a.payload.revision)}</code>
        <span>Tree</span><code>{str(a.payload.tree_hash)}</code>
        <span>Base</span><code>{str(a.payload.base_hash ?? v.started?.payload.base_hash)}</code>
        <span>Evidence</span><span>{v.citations.map((c, i) => <span key={c.id} className={c.event ? undefined : "fail"}>{i ? " " : ""}#{c.id}{!c.event ? " (missing)" : c.stale ? " (stale)" : ""}</span>)}</span>
        <span>Open findings</span><span>{v.findings.filter((f) => !isResolved(f.action)).length}</span>
      </div>}
      {v.approvalResult ? <p className="decision">Decision recorded: <strong>{approved(v.approvalResult) ? "Approved" : "Rejected"}</strong></p> : (
        <>
          {!v.gate.ok && <ul className="reasons">{v.gate.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          <div className="btns">
            <button className="primary" disabled={!v.gate.ok || busy} onClick={() => onDecide(true)}>Approve <code>{short(a?.code_rev)}</code></button>
            <button disabled={busy || !!v.done} onClick={() => onDecide(false)}>Reject</button>
          </div>
        </>
      )}
      {error && <p className="fail">{error}</p>}
    </section>
  );
}

/** One cited event, described by what it attests to. */
function cited(e: MissionEvent): { name: string; outcome: string; ok?: boolean } {
  const p = e.payload;
  switch (e.type) {
    case "test_result": return { name: str(p.suite_id ?? p.check_id, "check"), outcome: cap(str(p.outcome, "unknown")), ok: p.outcome === "passed" };
    case "finding": return { name: str(p.finding_id, `#${e.id}`), outcome: `${humanize(str(p.action, "open"))} · ${str(p.severity, "info")}`, ok: isResolved(str(p.action)) || p.blocking === false };
    case "diff": return { name: Array.isArray(p.changed_paths) ? p.changed_paths.join(", ") : "Revision", outcome: "Revision recorded" };
    case "tool_result": return { name: str(p.call_id, "tool"), outcome: p.ok === false ? "Error" : "OK", ok: p.ok !== false };
    default: return { name: eventLabel(e.type), outcome: "—" };
  }
}

export function WhyApprove({ v, fetchArtifact }: { v: View; fetchArtifact?: (id: string) => Promise<string> }) {
  const [downloadError, setDownloadError] = useState("");
  const a = v.pendingApproval ?? v.approvalResult;
  if (!a) return null;
  const rev = a.code_rev ?? (str(a.payload.revision) || null);
  const diffs = revisionDiffs(v.diffs, rev); const latest = diffs[diffs.length - 1];
  const base = str(a.payload.base_hash) || str(latest?.payload.base_hash) || str(v.started?.payload.base_hash);
  const tree = str(a.payload.tree_hash);
  const missing = v.citations.filter((c) => !c.event);
  const missionId = a.mission_id;

  // Isolation is stamped only on test_result payloads; judge the runs at this revision plus anything cited.
  const runs = v.events.filter((e) => e.type === "test_result" && (e.code_rev === rev || v.citations.some((c) => c.id === e.id)));
  const isolation = runs.some((e) => v.unisolated.has(e.id)) ? "unisolated" : runs.length && runs.every((e) => e.payload.isolation === "isolated") ? "isolated" : "unknown";

  const descriptions = new Map((Array.isArray(v.plan?.payload.criteria) ? v.plan!.payload.criteria as Record<string, unknown>[] : [])
    .filter((c) => c && typeof c === "object").map((c) => [str(c.id), str(c.description)]));
  const checks = v.checks.filter((c) => c.code_rev === rev);

  const done = v.done; const appliedRev = str(done?.payload.applied_revision);
  const appliedPath = str(done?.payload.applied_path ?? done?.payload.applied_to ?? v.approvalResult?.payload.applied_path);
  const landed = appliedRev || appliedPath
    ? <span className="pass">Applied {appliedRev && <code title={appliedRev}>{short(appliedRev)}</code>} to <code>{appliedPath || `runtime/missions/${missionId}/target/current`}</code>{done?.payload.recovered === true ? " (recovered after restart)" : ""}</span>
    : v.approvalResult && !approved(v.approvalResult) ? <span className="muted">Not applied: rejected</span>
    : done ? <span className="warn">Not applied: mission {str(done.payload.status, "finished").toLowerCase()}{v.escalations.length ? ` (${humanize(str(v.escalations[v.escalations.length - 1].payload.reason))})` : ""}</span>
    : v.approvalResult ? <span className="muted">Approved; applying</span>
    : <span className="muted">Not applied yet</span>;

  const download = async () => {
    setDownloadError("");
    try {
      if (!latest) throw new Error("No diff recorded for this revision.");
      const artifact = str(latest.payload.artifact_id ?? latest.payload.diff_artifact_id);
      const text = typeof latest.payload.text === "string" ? latest.payload.text
        : artifact && fetchArtifact ? await fetchArtifact(artifact) : null;
      if (text === null) throw new Error("The diff text is not available.");
      const blob = new Blob([buildPatch(text, { mission: missionId, revision: rev, base, tree })], { type: "text/x-diff" });
      const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = `${missionId}-${(rev ?? "revision").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40)}.patch`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) { setDownloadError(`Could not build the patch: ${e instanceof Error ? e.message : String(e)}`); }
  };

  return (
    <section className="card why">
      <h3>Why approve {v.pendingApproval && !v.approvalResult && <span className={v.gate.ok ? "tag ok" : "tag stale"}>{v.gate.ok ? "gate passes" : "gate blocked"}</span>}
        <button className="why-download" disabled={!latest} onClick={download} title={latest ? "Unified diff from the original base to this revision" : "No diff recorded for this revision"}>Download patch</button></h3>
      <div className="kv">
        <span>Revision</span><code>{rev ?? "—"}</code>
        <span>Tree hash</span><code>{tree || "—"}</code>
        <span>Base hash</span><code>{base || "—"}</code>
        <span>Isolation</span><span><span className={isolation === "isolated" ? "tag ok why-badge" : "tag uniso why-badge"} title={isolation === "unisolated" ? "A run lacked sandbox isolation. It cannot satisfy the gate." : isolation === "isolated" ? "Every check at this revision ran in the isolated runner" : "No isolation stamp on the checks for this revision"}>{isolation}</span></span>
        <span>Landed</span>{landed}
      </div>
      <h4>Cited evidence</h4>
      {missing.length > 0 && <p className="fail small">Missing evidence {missing.map((c) => `#${c.id}`).join(", ")}: not in this mission's event stream. The gate does not pass.</p>}
      <table className="tbl">
        <thead><tr><th>Event</th><th>Type</th><th>Subject</th><th>Result</th><th>Revision</th><th>Source</th></tr></thead>
        <tbody>
          {v.citations.length === 0 && <tr><td colSpan={6} className="fail">The approval cites no evidence.</td></tr>}
          {v.citations.map((c) => {
            if (!c.event) return <tr key={c.id} className="why-missing"><td className="mono fail">#{c.id}</td><td colSpan={5} className="fail">Missing: no such event in this mission</td></tr>;
            const d = cited(c.event);
            return <tr key={c.id} className={c.stale ? "is-stale" : ""}>
              <td className="mono">#{c.id}</td><td>{eventLabel(c.event.type)}</td><td className="mono">{d.name}</td>
              <td className={d.ok === undefined ? "" : d.ok ? "pass" : "fail"}>{d.outcome}</td>
              <td><code title={c.event.code_rev ?? undefined}>{short(c.event.code_rev)}</code></td>
              <td><Prov e={c.event} stale={c.stale} unisolated={RUN_TYPES.has(c.event.type) && v.unisolated.has(c.event.id)} /></td>
            </tr>;
          })}
        </tbody>
      </table>
      <h4>Checks and acceptance criteria at this revision</h4>
      {checks.length === 0 ? <p className="muted">No checks have run on this revision.</p> : <ul className="why-checks">
        {checks.map((c) => {
          const criteria = Array.isArray(c.event.payload.criteria) ? c.event.payload.criteria as { id?: unknown; passed?: unknown }[] : [];
          return <li key={c.key}>
            <span className={c.outcome === "passed" && !c.stale ? "pass" : "fail"}>{c.outcome === "passed" ? "✓" : "✗"}</span> <span className="mono">{c.key}</span> <span className="muted small">{c.kind === "acceptance" ? "Acceptance suite" : "Project check"} · {cap(c.outcome)} · #{c.event.id}</span>
            {criteria.length > 0 && <ul>{criteria.map((x, i) => <li key={i}><span className={x.passed === true ? "pass" : "fail"}>{x.passed === true ? "✓" : "✗"}</span> <span className="mono">{str(x.id, `criterion ${i + 1}`)}</span>{descriptions.get(str(x.id)) ? <span className="muted"> {descriptions.get(str(x.id))}</span> : null}</li>)}</ul>}
          </li>;
        })}
      </ul>}
      {downloadError && <p className="fail">{downloadError}</p>}
    </section>
  );
}
