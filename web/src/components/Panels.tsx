import { useEffect, useRef, useState } from "react";
import type { MissionEvent } from "../lib/types";
import { agentTurns, approved, buildPatch, col, isOpen, isResolved, revisionDiffs, secondsLeft, str, tamperOf, tamperText, type Finding, type View } from "../lib/derive";
import { HELP, OUTDATED_LABEL, agentName, checkHelp, checkLabel, eventLabel, gateReason, humanize, plural, sourceHelp, sourceLabel, stateLabel, versionLabel } from "../lib/labels";

// All dynamic text is rendered as React text nodes (never innerHTML).
export const Prov = ({ e, stale, unisolated }: { e: { verified: boolean }; stale?: boolean; unisolated?: boolean }) => (
  <span className="prov">
    {unisolated && <span className="tag uniso" title={HELP.unisolated}>No protected environment <Hint text={HELP.unisolated} /></span>}
    <span className={e.verified ? "tag ok" : "tag claim"} title={sourceHelp(e.verified)}>{sourceLabel(e.verified)} <Hint text={sourceHelp(e.verified)} /></span>
    {stale && <span className="tag stale" title={HELP.outdated}>{OUTDATED_LABEL} <Hint text={HELP.outdated} /></span>}
  </span>
);
export function Hint({ text }: { text: string }) {
  return <span className="help-hint" tabIndex={0} title={text} aria-label={text}>?</span>;
}
export function Version({ revision }: { revision: string | null | undefined }) {
  return <div className="version-label"><span title={revision ?? HELP.version}>{versionLabel(revision)}</span>{revision && <details className="hash-details"><summary title="Show the full code version hash so you can copy it">View hash</summary><code>{revision}</code></details>}</div>;
}
function Snapshot({ value }: { value: string }) {
  return value ? <code className="snapshot-hash">{value}</code> : <span className="muted">Not recorded</span>;
}
export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
const clock = (s: number) => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const COLUMNS: Record<string, string> = { pending: "Pending", ready: "Ready", running: "Running", blocked: "Blocked", done: "Done" };

export function Header({ v, mode, conn, now, missionId, repo }: { v: View; mode: string; conn: string; now: number; missionId: string; repo: string }) {
  const clockLeft = secondsLeft(v, v.done?.ts ?? now); const left = clockLeft?.left ?? null;
  const terminal = !!v.done || v.state === "ESCALATED" || v.state === "REJECTED";
  const endTs = v.done?.ts ?? v.events[v.events.length - 1]?.ts;
  const wall = Number(v.done?.payload.wall_elapsed_ms);
  const took = terminal && v.started && endTs ? Math.max(0, Math.round((Number.isFinite(wall) && wall > 0 ? wall : endTs - v.started.ts) / 1000)) : null;
  return (
    <header className="mhead">
      <div className="mission-meta"><div><span>Repository</span><strong>{str(v.started?.payload.repo, repo)}</strong></div><details className="mission-id"><summary>Mission ID</summary><code>{v.started?.mission_id ?? missionId}</code></details></div>
      <div className="request-label">Request</div>
      <blockquote className="req">{str(v.started?.payload.request, "Waiting for the mission request…")}</blockquote>
      <div className="hstats">
        <div className="hstat"><span>Status</span><strong className={`state s-${v.state.toLowerCase()}`}>{stateLabel(v.state)}</strong></div>
        <div className="hstat"><span>{took !== null ? "Duration" : "Time left"}</span><strong className={left !== null && left < 30 && !clockLeft?.paused && took === null ? "warn" : ""} title={took !== null ? "Total mission duration" : clockLeft?.paused ? "The deadline is paused while approval is pending" : "Time left before the mission deadline, including any extensions"}>{took !== null ? clock(took) : left !== null ? `${clock(left)}${clockLeft?.paused ? " · paused" : ""}` : "Not reported"}</strong></div>
        <div className="hstat"><span>Fix rounds used <Hint text={HELP.fixRounds} /></span><strong>{v.fixCycles} of 3</strong></div>
        <div className="hstat"><span>Model turns <Hint text={HELP.turns} /></span><strong title={v.usage ? Object.entries(v.usage.per_agent).map(([a, u]) => { const used = agentTurns(v.usage, a) ?? u.turns; const cap = v.budget?.[a]; return `${agentName(a)}: ${used}${cap !== undefined && used <= cap ? `/${cap}` : ""} turns`; }).join("\n") : undefined}>{v.usage ? v.usage.total.turns : "Not reported"}</strong></div>
        <div className="hstat"><span>Tokens <Hint text={HELP.tokens} /></span><strong title={v.usage ? `${v.usage.total.input_tokens.toLocaleString()} input + ${v.usage.total.output_tokens.toLocaleString()} output tokens` : undefined}>{v.usage ? fmtTok(v.usage.total.input_tokens + v.usage.total.output_tokens) : "Not reported"}</strong></div>
        <div className="hstat"><span>Code version <Hint text={HELP.version} /></span><Version revision={v.currentRev} /></div>
      </div>
      {v.unisolated.size > 0 && <div className="header-notice"><span className="tag uniso" title={HELP.unisolated}>Some results ran without a protected environment <Hint text={HELP.unisolated} /></span></div>}
      {mode === "live" && (conn === "connecting" || conn === "reconnecting") && <div className="header-notice">{conn === "connecting" ? "Connecting to mission updates…" : "Reconnecting to mission updates…"}</div>}
    </header>
  );
}

export function Escalation({ v, onCite }: { v: View; onCite?: (id: number) => void }) {
  if (!v.escalations.length) return null;
  const e = v.escalations[v.escalations.length - 1];
  return (
    <div className="banner">
      <strong>Escalated to you.</strong> <span title={str(e.payload.reason)}>{humanize(str(e.payload.reason))}</span>
      {(e.payload.question || e.payload.action) ? <div className="q">{str(e.payload.question ?? e.payload.action)}</div> : null}
      {(() => { const raw = Array.isArray(e.payload.relevant_event_ids) ? e.payload.relevant_event_ids : Array.isArray(e.payload.event_ids) ? e.payload.event_ids : []; const ids = raw.filter((id): id is number => typeof id === "number"); return <div className="muted small">{ids.length > 0 && <>Related events <CiteLinks ids={ids} onCite={onCite} /></>}{ids.length > 0 && e.payload.reason === "AMBIGUOUS_REQUEST" && " · "}{e.payload.reason === "AMBIGUOUS_REQUEST" && "Start a new mission with a clearer request."}</div>; })()}
    </div>
  );
}

export function TaskBoard({ v }: { v: View }) {
  const cols = ["pending", "ready", "running", "blocked", "done"];
  const crit = Array.isArray(v.plan?.payload.criteria) ? (v.plan!.payload.criteria as unknown[]) : [];
  return (
    <section className="card" key={v.plan?.id ?? 0}>
      <h3>Plan and tasks {v.plan && <span className="h-meta">Plan version {str(v.plan.payload.version)}</span>} {v.plan && <Prov e={v.plan} />}</h3>
      <p className="section-description">The agents' plan and the current state of each task.</p>
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
export function Timeline({ v, filter, setFilter, focus, onCite }: { v: View; filter: string; setFilter: (filter: string) => void; focus?: number | null; onCite?: (id: number) => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(focus ?? null);
  const focusRef = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focus != null) { setSelectedId(focus); focusRef.current?.scrollIntoView({ block: "center" }); } }, [focus]);
  const agents = Array.from(new Set(["all", ...(filter !== "all" ? [filter] : []), ...v.events.map((e) => e.agent)]));
  const list = v.events.filter((e) => filter === "all" || e.agent === filter);
  const selected = list.find((e) => e.id === selectedId) ?? list[list.length - 1];
  const start = list.length ? Math.min(...list.map((e) => e.ts)) : 0;
  const end = list.length ? Math.max(...list.map((e) => e.ts)) : 0;
  const duration = end - start;
  const lanes = Array.from(new Set(list.map((e) => e.agent)));
  return (
    <section className="card tl">
      <div className="section-heading-row"><div><h3>Full event log</h3><p className="section-description">Each event records an action or result. Read the log below, or select a dot to inspect an event on the timeline.</p></div>
        <label className="filter-label">Filter by agent<select aria-label="Filter by agent" value={filter} onChange={(e) => setFilter(e.target.value)}>{agents.map((a) => <option key={a} value={a}>{a === "all" ? "All agents" : agentName(a)}</option>)}</select></label>
      </div>
      <div className="trace-layout">
        <div className="trace" aria-label="Event trace">
          {list.length ? <>
            <div className="trace-axis"><span>Agent</span><div><span>{time(start)}</span><span>{duration ? time(start + duration / 2) : ""}</span><span>{duration ? time(end) : ""}</span></div></div>
            {lanes.map((agent) => <div className="trace-lane" key={agent}><span className="trace-agent">{agentName(agent)}</span><div className="trace-track">{list.filter((e) => e.agent === agent).map((e) => <button type="button" key={e.id} className={`trace-event ${e.type === "agent_msg" ? "message" : ""} ${selected?.id === e.id ? "selected" : ""}`} style={{ left: `${duration ? ((e.ts - start) / duration) * 100 : 50}%` }} onClick={() => setSelectedId(e.id)} aria-label={`${eventLabel(e.type)}, #${e.id}, ${time(e.ts)}`} aria-pressed={selected?.id === e.id} title={`${eventLabel(e.type)} · #${e.id}${summary(e) ? `\n${summary(e)}` : ""}`} />)}</div></div>)}
          </> : <p className="muted trace-empty">No activity from this agent yet.</p>}
        </div>
        {selected && <aside className="trace-detail" aria-label="Selected event">
          <div className="trace-detail-heading"><strong title={selected.type}>{eventLabel(selected.type)}</strong><span className="mono muted">#{selected.id}</span></div><div className="trace-detail-meta">{agentName(selected.agent)} · <span className="num">{time(selected.ts)}</span> <Prov e={selected} stale={v.staleIds.has(selected.id)} unisolated={RUN_TYPES.has(selected.type) && v.unisolated.has(selected.id)} /></div><div className="esum">{summary(selected)}</div>
          {eventCitations(selected).length > 0 && <div className="event-citations">Related events <CiteLinks ids={eventCitations(selected)} onCite={onCite} /></div>}
        </aside>}
      </div>
      <div className="log-label">Event log{filter !== "all" && <span>{list.length}</span>}</div>
      <ol className="events">
        {list.map((e) => (
          <li key={e.id} ref={e.id === focus ? focusRef : undefined} className={`${v.staleIds.has(e.id) ? "is-stale" : ""}${e.id === focus ? " is-focus" : ""}`}>
            <span className="muted mono">#{e.id} {time(e.ts)}</span>
            <span className={`agent a-${e.agent}`} title={e.agent}>{agentName(e.agent)}</span>
            <span className="etype" title={e.type === "tool_call" || e.type === "tool_result" ? HELP.tool : e.type}>{eventLabel(e.type)}{(e.type === "tool_call" || e.type === "tool_result") && <Hint text={HELP.tool} />}</span>
            <Prov e={e} stale={v.staleIds.has(e.id)} unisolated={RUN_TYPES.has(e.type) && v.unisolated.has(e.id)} />
            {summary(e) && <div className="esum">{summary(e)}</div>}
            {eventCitations(e).length > 0 && <div className="event-citations">Related events <CiteLinks ids={eventCitations(e)} onCite={onCite} /></div>}
            <details className="event-details"><summary>Show full event details</summary><pre>{JSON.stringify(e.payload, null, 2)}</pre></details>
          </li>
        ))}
      </ol>
    </section>
  );
}
export function summary(e: MissionEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "mission_started": return `Repository: ${str(p.repo)} · Original repository snapshot: ${str(p.base_hash)}`;
    case "plan": return `Plan version ${str(p.version)} · ${plural(Array.isArray(p.tasks) ? p.tasks.length : 0, "task")}`;
    case "task_update": return `${str(p.task_id)}: ${humanize(str(p.previous_status))} → ${humanize(str(p.new_status ?? p.status))}`;
    case "agent_msg": return `To ${agentName(str(p.to ?? p.recipient))}: ${str(p.message)}${Array.isArray(p.findings) ? ` · ${plural(p.findings.length, "finding")}` : ""}${typeof p.scanner_findings === "number" ? ` · ${plural(p.scanner_findings, "scanner finding")}` : ""}`;
    case "turn_start": case "turn_end": return "";
    case "tool_call": return `${str(p.tool)}(${JSON.stringify(p.arguments ?? p.args ?? {})})`;
    case "tool_result": { if (p.ok === false) return `Error ${str((p.error as Record<string, unknown> | undefined)?.code ?? p.error, "unknown")}`; const d = p.data as Record<string, unknown> | undefined; const s = d ? (typeof d.content === "string" ? d.content : JSON.stringify(d)) : str(p.result, "ok"); return s; }
    case "test_result": { const cr = Array.isArray(p.criteria) ? (p.criteria as { passed?: boolean }[]) : null; return `${p.phase === "baseline" ? "Before changes · " : ""}${checkLabel(str(p.suite_id ?? p.check_id, "check"), p.suite_id ? "acceptance" : "check")}: ${humanize(str(p.outcome))}${p.exit_code !== undefined ? ` (exit code ${str(p.exit_code)})` : ""}${cr ? ` · ${cr.filter((c) => c.passed).length} of ${cr.length} criteria passed` : ""}`; }
    case "finding": { const t = tamperOf(e); if (t) return `Blocked: ${tamperText(t)} (${t.code})`; return `${str(p.finding_id)} ${isResolved(str(p.action)) ? "resolved" : humanize(str(p.action)).toLowerCase()} · ${str(p.severity)} · ${[str(p.title), str(p.detail ?? p.description)].filter(Boolean).join(" — ") || str(p.resolution)}${p.carried_forward === true ? " · carried forward" : ""}${p.unaccepted_resolution ? ` · resolution not accepted: ${str(p.unaccepted_resolution)}` : ""}`; }
    case "diff": return `${versionLabel(e.code_rev ?? str(p.revision))}: ${Array.isArray(p.changed_paths) ? p.changed_paths.join(", ") : ""}`;
    case "approval_needed": case "approval_requested": return versionLabel(e.code_rev);
    case "approval_result": return approved(e) ? "Approved" : "Rejected";
    case "escalation": return `${humanize(str(p.reason))}: ${str(p.question)}`;
    case "stale": return `${versionLabel(str(p.old_revision))} → ${versionLabel(str(p.new_revision))}: ${str(p.reason)} · earlier evidence became outdated`;
    case "mission_done": return stateLabel(str(p.status));
    case "usage": { const t = p.total as { turns: number; input_tokens: number; output_tokens: number }; return `${plural(t.turns, "turn")} · ${fmtTok(t.input_tokens)} in / ${fmtTok(t.output_tokens)} out tokens`; }
  }
}

function eventCitations(e: MissionEvent): number[] {
  const keys = ["evidence_ids", "evidence_event_ids", "cited_event_ids", "reason_event_ids", "cause_event_ids", "relevant_event_ids", "invalidated", "affected_evidence_ids"];
  return [...new Set(keys.flatMap((key) => Array.isArray(e.payload[key]) ? (e.payload[key] as unknown[]).filter((id): id is number => typeof id === "number") : []))];
}

/** Event-id links; `onCite` opens the event in the activity log. */
export function CiteLinks({ ids, onCite }: { ids: number[]; onCite?: (id: number) => void }) {
  if (!ids.length) return null;
  return <span className="cites">{ids.map((id) => onCite
    ? <button type="button" key={id} className="cite-link mono" onClick={() => onCite(id)} title="Show this event in the Full event log">#{id}</button>
    : <span key={id} className="mono muted">#{id}</span>)}</span>;
}

/** A refused file-tool call. The refusal is the outcome; it never blocks approval. */
export function TamperChip({ f }: { f: Finding }) {
  if (!f.tamper) return null;
  return <span className="tamper-chip" title={f.description}>Blocked: {tamperText(f.tamper)}</span>;
}

export function Tampers({ v, onCite, compact }: { v: View; onCite?: (id: number) => void; compact?: boolean }) {
  if (!v.tampers.length) return null;
  return (
    <section className={`tamper-callout${compact ? " compact" : ""}`} aria-label="Tamper attempts blocked">
      <div className="tamper-head"><strong>Tamper attempts blocked ({v.tampers.length})</strong><span className="muted small">Refused by the service. Informational; these do not block approval.</span></div>
      <ul>{v.tampers.map((f) => (
        <li key={f.id} className={f.stale ? "is-stale" : ""}>
          <TamperChip f={f} /> <code className="tamper-code" title="Refusal code">{f.tamper!.code}</code>
          {f.actor && <span className="muted small"> {agentName(f.actor)}</span>}
          {!compact && <span className="muted small"> · {f.tamper!.tool}</span>} <CiteLinks ids={f.evidenceIds.length ? f.evidenceIds : [f.eventId]} onCite={onCite} />
        </li>
      ))}</ul>
    </section>
  );
}

export function Evidence({ v, onCite }: { v: View; onCite?: (id: number) => void }) {
  return (
    <section className="card">
      <h3>Test results</h3>
      <p className="section-description">The latest recorded result for each test or check, including which code version it ran against.</p>
      {v.checks.length === 0 && <p className="muted">No tests or checks have run yet.</p>}
      <div className="result-list">{v.checks.map((c) => (
        <article key={c.key} className={`result-card ${c.stale ? "is-stale" : ""}`}>
          <div className="result-heading"><div><h4>{checkLabel(c.key, c.kind)} <Hint text={checkHelp(c.key, c.kind)} /></h4><p>{checkHelp(c.key, c.kind)}</p></div><strong className={`result-outcome ${c.outcome === "passed" ? "pass" : "fail"}`}>{cap(c.outcome)}</strong></div>
          <div className="result-meta">
            <div><span>Runs <Hint text={HELP.runs} /></span><strong>{c.attempts}</strong></div>
            <div><span>Code version <Hint text={HELP.version} /></span><Version revision={c.code_rev} /></div>
            <div><span>Source</span><Prov e={c.event} stale={c.stale} unisolated={v.unisolated.has(c.event.id)} /></div>
            <div><span>Recorded event</span><CiteLinks ids={[c.event.id]} onCite={onCite} /></div>
          </div>
          {(c.exit !== undefined || Array.isArray(c.event.payload.criteria) || c.duration !== undefined) && <p className="result-extra">
            {c.exit !== undefined && <span>Exit code {c.exit} <Hint text={HELP.exitCode} /></span>}
            {Array.isArray(c.event.payload.criteria) && <span>{(c.event.payload.criteria as { passed?: boolean }[]).filter((x) => x.passed).length} of {(c.event.payload.criteria as unknown[]).length} criteria passed</span>}
            {c.duration !== undefined && <span>Duration: {c.duration} ms <Hint text={HELP.milliseconds} /></span>}
          </p>}
          <details className="raw-id"><summary>Show test ID</summary><code>{c.key}</code></details>
        </article>
      ))}</div>
      <Tampers v={v} onCite={onCite} />
      <h3 className="subsection-title">Review findings <Hint text={HELP.findings} /></h3>
      <p className="section-description">Issues reported by the reviewers, their status, and the events they refer to.</p>
      {v.findings.length === 0 && <p className="muted">No findings have been reported. Review conclusions are agent-reported.</p>}
      {v.findings.map((f) => (
        <div key={f.id} className={`finding ${f.stale ? "is-stale" : ""}`}>
          <div className="finding-heading"><strong>{isResolved(f.action) ? "Resolved" : "Open"} finding</strong><span className={`sev sev-${f.severity}`}>{humanize(f.severity)} severity</span>{f.blocking && <span className="tag back">{isResolved(f.action) ? "Previously blocking" : "Blocks approval"}</span>}</div>
          <div className="muted small">Reported by {agentName(f.agent)} · Finding <code>{f.id}</code> · Event <CiteLinks ids={[f.eventId]} onCite={onCite} /></div>
          <Prov e={f} stale={f.stale} unisolated={v.unisolated.has(f.eventId)} />
          {f.sentBack && <span className="tag back">Sent back to Samurai</span>}
          {f.carriedForward && <span className="tag back" title="The reviewer omitted this blocking critical from its later report; it stays open until resolved with evidence">Kept open from an earlier review <Hint text="The reviewer omitted this blocking critical from its later report; it stays open until resolved with evidence." /></span>}
          {f.unacceptedResolution && <span className="tag back" title={f.unacceptedResolution}>Resolution not accepted</span>}
          <div className="finding-text">{f.description}</div>
          {f.unacceptedResolution && <div className="fail small">Resolution not accepted: {f.unacceptedResolution}{f.blocking ? " Still blocking." : ""}</div>}
          {f.resolutionEvidence && <div className="muted small">Resolution evidence: <code>{f.resolutionEvidence.path}{f.resolutionEvidence.line !== undefined ? `:${f.resolutionEvidence.line}` : ""}</code></div>}
          {f.resolution && <div className="muted small">Resolution: {f.resolution}</div>}
          {f.evidenceIds.length > 0 && <div className="muted small">Related events <CiteLinks ids={f.evidenceIds} onCite={onCite} /></div>}
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
      <div className="section-heading-row"><div><h3>Code changes</h3><p className="section-description">Lines added and removed since the original repository snapshot.</p></div>
        {v.diffs.length > 1 && <label className="filter-label">Choose a version<select aria-label="Choose a code version" value={idx < 0 ? v.diffs.length - 1 : idx} onChange={(e) => setIdx(Number(e.target.value))}>
          {v.diffs.map((x, i) => <option key={x.id} value={i}>{versionLabel(x.code_rev ?? str(x.payload.revision))}{i === v.diffs.length - 1 ? " (latest)" : ""}</option>)}</select></label>}
      </div>
      {!d ? <p className="muted">No code changes recorded yet.</p> : (
        <>
          <div className="diff-meta"><div><span>Code version <Hint text={HELP.version} /></span><Version revision={d.code_rev ?? str(d.payload.revision)} /></div><div><span>Original repository snapshot <Hint text={HELP.originalSnapshot} /></span><Snapshot value={str(d.payload.base_hash)} /></div>{Array.isArray(d.payload.changed_paths) && <div><span>Changed files</span><code>{d.payload.changed_paths.map((path) => str(path)).join(", ")}</code></div>}</div>
          <pre className="diff">{text.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l || " "}</div>)}</pre>
        </>
      )}
    </section>
  );
}

export function Approval({ v, onDecide, busy, error, onCite }: { v: View; onDecide: (a: boolean) => void; busy: boolean; error: string; onCite?: (id: number) => void }) {
  const a = v.pendingApproval;
  if (!a && !v.approvalResult) return null;
  return (
    <section className={`card approval ${approved(v.approvalResult) ? "sealed" : ""}`}>
      <h3>Your decision</h3>
      <p className="section-description">Review the code version and its supporting evidence before you approve or reject it.</p>
      {a && <div className="kv">
        <span>Code version <Hint text={HELP.version} /></span><Version revision={a.code_rev ?? str(a.payload.revision)} />
        <span>Snapshot of the changed files <Hint text={HELP.changedSnapshot} /></span><Snapshot value={str(a.payload.tree_hash)} />
        <span>Original repository snapshot <Hint text={HELP.originalSnapshot} /></span><Snapshot value={str(a.payload.base_hash ?? v.started?.payload.base_hash)} />
        <span>Supporting events</span><span className="citation-list">{v.citations.length ? v.citations.map((c) => <span key={c.id} className={c.event ? undefined : "fail"}>{c.event ? <CiteLinks ids={[c.id]} onCite={onCite} /> : `#${c.id} (missing)`}{c.stale && c.event ? ` (${OUTDATED_LABEL})` : ""}</span>) : "None"}</span>
        <span>Open findings</span><span>{v.findings.filter(isOpen).length}{v.tampers.length ? <span className="muted small"> · {plural(v.tampers.length, "tamper attempt")} blocked (not counted)</span> : null}</span>
      </div>}
      {v.approvalResult ? <p className="decision">Decision recorded: <strong>{approved(v.approvalResult) ? "Approved" : "Rejected"}</strong></p> : (
        <>
          {!v.gate.ok && <><p className="fail"><strong>Approval is blocked for these reasons:</strong></p><ul className="reasons">{v.gate.reasons.map((r) => <li key={r}>{gateReason(r, v.checks)}</li>)}</ul></>}
          <div className="btns">
            <button className="primary" disabled={!v.gate.ok || busy} onClick={() => onDecide(true)}>Approve change</button>
            <button disabled={busy || !!v.done} onClick={() => onDecide(false)}>Reject change</button>
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
    case "test_result": return { name: checkLabel(str(p.suite_id ?? p.check_id, "check"), p.suite_id ? "acceptance" : "check"), outcome: cap(str(p.outcome, "unknown")), ok: p.outcome === "passed" };
    case "finding": { const t = tamperOf(e); if (t) return { name: `Blocked: ${tamperText(t)}`, outcome: `Refused · ${t.code}`, ok: true }; return { name: str(p.finding_id, `#${e.id}`), outcome: `${humanize(str(p.action, "open"))} · ${str(p.severity, "info")}`, ok: isResolved(str(p.action)) || p.blocking === false }; }
    case "diff": return { name: Array.isArray(p.changed_paths) ? p.changed_paths.join(", ") : "Code changes", outcome: "Code version recorded" };
    case "tool_result": return { name: str(p.call_id, "tool"), outcome: p.ok === false ? "Error" : "OK", ok: p.ok !== false };
    default: return { name: eventLabel(e.type), outcome: "—" };
  }
}

export function WhyApprove({ v, fetchArtifact, onCite }: { v: View; fetchArtifact?: (id: string) => Promise<string>; onCite?: (id: number) => void }) {
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
    ? <div className="pass">Applied {appliedRev && <Version revision={appliedRev} />} to <code>{appliedPath || `runtime/missions/${missionId}/target/current`}</code>{done?.payload.recovered === true ? " (recovered after restart)" : ""}</div>
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
      <div className="section-heading-row"><div><h3>Evidence for this decision {v.pendingApproval && !v.approvalResult && <span className={v.gate.ok ? "tag ok" : "tag stale"}>{v.gate.ok ? "Requirements met" : "Approval blocked"}</span>}</h3>
        <p className="section-description">Inspect the recorded results and the code snapshots behind this decision.</p></div>
        <button className="why-download" disabled={!latest} onClick={download} title={latest ? HELP.patch : "No code changes recorded for this version"}>Download code changes</button></div>
      <div className="kv">
        <span>Code version <Hint text={HELP.version} /></span><Version revision={rev} />
        <span>Snapshot of the changed files <Hint text={HELP.changedSnapshot} /></span><Snapshot value={tree} />
        <span>Original repository snapshot <Hint text={HELP.originalSnapshot} /></span><Snapshot value={base} />
        <span>Test environment <Hint text={HELP.isolation} /></span><span><span className={isolation === "isolated" ? "tag ok why-badge" : "tag uniso why-badge"} title={isolation === "unisolated" ? HELP.unisolated : isolation === "isolated" ? "Every check at this version ran in a protected environment" : "No environment information was recorded for these checks"}>{isolation === "isolated" ? "Protected" : isolation === "unisolated" ? "Not protected" : "Not recorded"}</span></span>
        <span>Applied change</span>{landed}
      </div>
      <h4>Supporting events</h4>
      <p className="section-description">Select an event number to see it in the full event log.</p>
      {missing.length > 0 && <p className="fail small">Missing evidence {missing.map((c) => `#${c.id}`).join(", ")}: no matching events were recorded for this mission. Approval is blocked.</p>}
      {v.citations.length === 0 && <p className="fail">The approval request does not refer to any evidence.</p>}
      <div className="cited-list">{v.citations.map((c) => {
        if (!c.event) return <div key={c.id} className="cited-row fail">#{c.id} · Missing: no such event in this mission</div>;
        const d = cited(c.event);
        return <div key={c.id} className={`cited-row ${c.stale ? "is-stale" : ""}`}>
          <div><CiteLinks ids={[c.id]} onCite={onCite} /> <strong>{eventLabel(c.event.type)}</strong> · <span>{d.name}</span></div>
          <div><span className={d.ok === undefined ? "" : d.ok ? "pass" : "fail"}>{d.outcome}</span> · <Version revision={c.event.code_rev} /> <Prov e={c.event} stale={c.stale} unisolated={RUN_TYPES.has(c.event.type) && v.unisolated.has(c.event.id)} /></div>
        </div>;
      })}</div>
      <h4>Tests and criteria for this version</h4>
      <p className="section-description">The latest results recorded for this code version.</p>
      {checks.length === 0 ? <p className="muted">No tests or checks have run on this version.</p> : <ul className="why-checks">
        {checks.map((c) => {
          const criteria = Array.isArray(c.event.payload.criteria) ? c.event.payload.criteria as { id?: unknown; passed?: unknown }[] : [];
          return <li key={c.key}>
            <span className={c.outcome === "passed" && !c.stale ? "pass" : "fail"}>{c.outcome === "passed" ? "✓" : "✗"}</span> <strong>{checkLabel(c.key, c.kind)}</strong> <Hint text={checkHelp(c.key, c.kind)} /> <span className="muted small">· {cap(c.outcome)} · Event <CiteLinks ids={[c.event.id]} onCite={onCite} /></span> <Prov e={c.event} stale={c.stale} unisolated={v.unisolated.has(c.event.id)} />
            {criteria.length > 0 && <ul>{criteria.map((x, i) => <li key={i}><span className={x.passed === true ? "pass" : "fail"}>{x.passed === true ? "✓" : "✗"}</span> <span className="mono">{str(x.id, `criterion ${i + 1}`)}</span>{descriptions.get(str(x.id)) ? <span className="muted"> {descriptions.get(str(x.id))}</span> : null}</li>)}</ul>}
          </li>;
        })}
      </ul>}
      {downloadError && <p className="fail">{downloadError}</p>}
    </section>
  );
}
