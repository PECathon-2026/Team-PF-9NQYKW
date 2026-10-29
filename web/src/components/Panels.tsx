import { useEffect, useState } from "react";
import type { MissionEvent } from "../lib/types";
import { approved, col, isResolved, short, str, type View } from "../lib/derive";

// All dynamic text is rendered as React text nodes (never innerHTML).
export const Prov = ({ e, stale, unisolated }: { e: { verified: boolean }; stale?: boolean; unisolated?: boolean }) => (
  <span className="prov">
    {unisolated && <span className="tag uniso" title="Ran without sandbox isolation; never counted as verified evidence for approval">unisolated</span>}
    <span className={e.verified ? "tag ok" : "tag claim"} title={e.verified ? "Directly observed by the service or a trusted runner" : "Model claim, not observed"}>{e.verified ? "verified" : "claimed"}</span>
    {stale && <span className="tag stale">stale</span>}
  </span>
);
export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });

export function Header({ v, mode, conn, now }: { v: View; mode: string; conn: string; now: number }) {
  const deadline = Number(v.started?.payload.deadline ?? 0);
  const left = deadline ? Math.max(0, Math.round((deadline - (v.done?.ts ?? now)) / 1000)) : null;
  return (
    <header className="mhead">
      <div>
        <div className="muted small">{str(v.started?.payload.repo, "—")} · {v.started?.mission_id ?? ""}</div>
        <div className="req">{str(v.started?.payload.request)}</div>
      </div>
      <div className="hstats">
        <span className={`state s-${v.state.toLowerCase()}`}>{v.state.replace(/_/g, " ")}</span>
        <span className="muted">rev <code>{short(v.currentRev)}</code></span>
        {left !== null && <span className={left < 30 ? "warn" : "muted"}>{left}s left</span>}
        <span className="muted">fix cycles {v.fixCycles}/3</span>
        {v.usage && <span className="muted" title={Object.entries(v.usage.per_agent).map(([a, u]) => `${a}: ${u.pass_turns ?? u.turns}${v.budget?.[a] !== undefined && (u.pass_turns !== undefined || u.turns <= v.budget[a]) ? `/${v.budget[a]}` : ""} turns, ${fmtTok(u.input_tokens + u.output_tokens)} tok`).join("\n")}>turns {v.usage.total.turns} · {fmtTok(v.usage.total.input_tokens + v.usage.total.output_tokens)} tok</span>}
        {v.unisolated.size > 0 && <span className="tag uniso" title="Runner has no sandbox isolation; results cannot satisfy the approval gate">unisolated runner</span>}
        <span className="muted">{mode === "replay" ? "simulated" : conn}</span>
      </div>
    </header>
  );
}

export function Escalation({ v }: { v: View }) {
  if (!v.escalations.length) return null;
  const e = v.escalations[v.escalations.length - 1];
  return (
    <div className="banner">
      <strong>Escalated to you:</strong> {str(e.payload.reason)}
      {(e.payload.question || e.payload.action) ? <div className="q">{str(e.payload.question ?? e.payload.action)}</div> : null}
      {(() => { const ids = Array.isArray(e.payload.relevant_event_ids) ? e.payload.relevant_event_ids : Array.isArray(e.payload.event_ids) ? e.payload.event_ids : []; return <div className="muted small">{[ids.length ? `Related events: ${ids.map((i) => `#${i}`).join(" ")}` : "", e.payload.reason === "AMBIGUOUS_REQUEST" ? "Start a new mission with a clarified request." : ""].filter(Boolean).join(" · ")}</div>; })()}
    </div>
  );
}

export function TaskBoard({ v }: { v: View }) {
  const cols = ["pending", "ready", "running", "done"];
  const crit = Array.isArray(v.plan?.payload.criteria) ? (v.plan!.payload.criteria as unknown[]) : [];
  return (
    <section className="card scroll" key={v.plan?.id ?? 0}>
      <h3>Plan {v.plan ? `v${str(v.plan.payload.version)}` : ""} {v.plan && <Prov e={v.plan} />}</h3>
      {crit.length > 0 && <ul className="crit">{crit.map((c, i) => <li key={i}>{typeof c === "object" && c ? `${str((c as Record<string, unknown>).id)}: ${str((c as Record<string, unknown>).description)}` : str(c)}</li>)}</ul>}
      {!v.plan && <p className="muted">No plan yet.</p>}
      <div className="board">
        {cols.map((c) => (
          <div key={c} className={`col${v.tasks.some((t) => col(t.status) === c) ? "" : " empty"}`}>
            <div className="colh">{c}</div>
            {!v.tasks.some((t) => col(t.status) === c) && <span className="empty-dash" aria-label="No tasks">—</span>}
            {v.tasks.filter((t) => col(t.status) === c).map((t) => (
              <div key={t.id} className="task"><div>{t.title}</div><div className="muted small">{t.role}{t.deps.length ? ` · after ${t.deps.join(", ")}` : ""}</div></div>
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
      <h3>Agent activity
        <select aria-label="Filter activity by agent" value={filter} onChange={(e) => setFilter(e.target.value)}>{agents.map((a) => <option key={a}>{a}</option>)}</select>
      </h3>
      <div className="trace-layout">
        <div className="trace" aria-label="Event trace">
          {list.length ? <>
            <div className="trace-axis"><span>Agent</span><div><span>{time(start)}</span><span>{duration ? time(start + duration / 2) : ""}</span><span>{duration ? time(end) : ""}</span></div></div>
            {lanes.map((agent) => <div className="trace-lane" key={agent}><span className="trace-agent">{agent.replace(/_/g, " ")}</span><div className="trace-track">{list.filter((e) => e.agent === agent).map((e) => <button type="button" key={e.id} className={`trace-event ${e.type === "agent_msg" ? "message" : ""} ${selected?.id === e.id ? "selected" : ""}`} style={{ left: `${duration ? ((e.ts - start) / duration) * 100 : 50}%` }} onClick={() => setSelectedId(e.id)} aria-label={`Event #${e.id}, ${e.type}, ${time(e.ts)}`} aria-pressed={selected?.id === e.id} title={`#${e.id} ${e.type}: ${summary(e)}`} />)}</div></div>)}
          </> : <p className="muted trace-empty">No events for this agent yet.</p>}
        </div>
        <aside className="trace-detail" aria-label="Selected event detail">
          {selected ? <><div className="trace-detail-heading"><span className="eyebrow">Selected event</span><span className="mono muted">#{selected.id}</span></div><strong>{selected.type.replace(/_/g, " ")}</strong><div className="trace-detail-meta">{selected.agent.replace(/_/g, " ")} · {time(selected.ts)} <Prov e={selected} stale={v.staleIds.has(selected.id)} unisolated={RUN_TYPES.has(selected.type) && v.unisolated.has(selected.id)} /></div><div className="esum">{summary(selected)}</div></> : <p className="muted">Select an event to inspect it.</p>}
        </aside>
      </div>
      <div className="log-label">Event log <span>{list.length} events</span></div>
      <ol className="events">
        {list.map((e) => (
          <li key={e.id} className={v.staleIds.has(e.id) ? "is-stale" : ""}>
            <span className="muted mono">#{e.id} {time(e.ts)}</span>
            <span className={`agent a-${e.agent}`}>{e.agent}</span>
            <span className="etype">{e.type}</span>
            <Prov e={e} stale={v.staleIds.has(e.id)} unisolated={RUN_TYPES.has(e.type) && v.unisolated.has(e.id)} />
            <div className="esum">{summary(e)}</div>
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
    case "mission_started": return `repo ${str(p.repo)} · base ${short(str(p.base_hash))}`;
    case "plan": return `plan v${str(p.version)} with ${Array.isArray(p.tasks) ? p.tasks.length : 0} tasks${cite("reason_event_ids")}`;
    case "task_update": return `${str(p.task_id)}: ${str(p.previous_status)} → ${str(p.new_status)}${cite("reason_event_ids")}`;
    case "agent_msg": return `→ ${str(p.to ?? p.recipient)}: ${str(p.message)}${Array.isArray(p.findings) ? ` · ${p.findings.length} findings` : ""}${typeof p.scanner_findings === "number" ? ` · scanner ${p.scanner_findings}` : ""}${cite("evidence_event_ids")}${cite("cited_event_ids")}`;
    case "tool_call": return `${str(p.tool)}(${JSON.stringify(p.arguments ?? p.args ?? {})})`;
    case "tool_result": { if (p.ok === false) return `error ${str((p.error as Record<string, unknown> | undefined)?.code ?? p.error, "unknown")}`; const d = p.data as Record<string, unknown> | undefined; const s = d ? (typeof d.content === "string" ? d.content : JSON.stringify(d)) : str(p.result, "ok"); return s; }
    case "test_result": { const cr = Array.isArray(p.criteria) ? (p.criteria as { passed?: boolean }[]) : null; return `${p.phase === "baseline" ? "baseline · " : ""}${str(p.suite_id ?? p.check_id)} ${str(p.outcome)}${p.exit_code !== undefined ? ` (exit ${str(p.exit_code)})` : ""}${cr ? ` · ${cr.filter((c) => c.passed).length}/${cr.length} criteria` : ""}${cite("cause_event_ids")}`; }
    case "finding": return `${str(p.finding_id)} ${str(p.action)} [${str(p.severity)}] ${str(p.title ?? p.description ?? p.resolution)}${cite("evidence_event_ids")}`;
    case "diff": return `${short(str(p.revision))}: ${Array.isArray(p.changed_paths) ? p.changed_paths.join(", ") : ""}`;
    case "approval_needed": return `approval for ${short(e.code_rev)}${cite("evidence_ids")}`;
    case "approval_result": return approved(e) ? "approved" : "rejected";
    case "escalation": return `${str(p.reason)}: ${str(p.question)}${cite("relevant_event_ids")}`;
    case "stale": { const inv = p.affected_evidence_ids ?? p.invalidated; return `${short(str(p.old_revision))} → ${short(str(p.new_revision))}: ${str(p.reason)} · invalidated ${Array.isArray(inv) ? inv.map((x) => `#${x}`).join(" ") : ""}`; }
    case "mission_done": return `${str(p.status)}`;
    case "usage": { const t = p.total as { turns: number; input_tokens: number; output_tokens: number }; return `total ${t.turns} turns · ${t.input_tokens} in / ${t.output_tokens} out tokens`; }
  }
}

export function Evidence({ v }: { v: View }) {
  return (
    <section className="card">
      <h3>Evidence</h3>
      <table className="tbl">
        <thead><tr><th>Check</th><th>Outcome</th><th>Attempts</th><th>Revision</th><th></th></tr></thead>
        <tbody>
          {v.checks.length === 0 && <tr><td colSpan={5} className="muted">No checks yet.</td></tr>}
          {v.checks.map((c) => (
            <tr key={c.key} className={c.stale ? "is-stale" : ""}>
              <td>{c.key}<div className="muted small">{c.kind === "acceptance" ? "acceptance suite" : "project check"}</div></td>
              <td key={c.event.id} className={c.outcome === "passed" ? "pass cut" : "fail"}>{c.outcome}{c.exit !== undefined ? ` · exit ${c.exit}` : ""}{Array.isArray(c.event.payload.criteria) ? <div className="muted small">{(c.event.payload.criteria as { passed?: boolean }[]).filter((x) => x.passed).length}/{(c.event.payload.criteria as unknown[]).length} criteria</div> : null}{c.duration !== undefined ? <div className="muted small">{c.duration} ms</div> : null}</td>
              <td>{c.attempts}</td>
              <td><code>{short(c.code_rev)}</code> <span className="muted small">#{c.event.id}</span></td>
              <td><Prov e={c.event} stale={c.stale} unisolated={v.unisolated.has(c.event.id)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Findings</h4>
      {v.findings.length === 0 && <p className="muted">No findings. A review with no findings is a model conclusion, not proof.</p>}
      {v.findings.map((f) => (
        <div key={f.id} className={`finding ${f.stale ? "is-stale" : ""}`}>
          <span className={`sev sev-${f.severity}`}>{f.severity}</span>
          <strong>{f.id}</strong> <span className="muted">{f.agent === "shadow_security" ? "security" : "review"}{f.blocking ? " · blocking" : ""}</span>
          <span key={f.action} className={isResolved(f.action) ? "pass cut" : "warn"}> {isResolved(f.action) ? "resolved" : "open"}</span>
          {f.sentBack && <span className="tag back">sent back to coder</span>}
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
    if (a && fetchArtifact) fetchArtifact(a).then(setText, (err) => setText(`Could not load artifact ${a}: ${String(err)}`));
  }, [d, fetchArtifact]);
  return (
    <section className="card">
      <h3>Diff
        {v.diffs.length > 1 && <select value={idx < 0 ? v.diffs.length - 1 : idx} onChange={(e) => setIdx(Number(e.target.value))}>
          {v.diffs.map((x, i) => <option key={x.id} value={i}>{short(x.code_rev)}{i === v.diffs.length - 1 ? " (current)" : ""}</option>)}</select>}
      </h3>
      {!d ? <p className="muted">No candidate yet.</p> : (
        <>
          <div className="muted small">base <code>{short(str(d.payload.base_hash))}</code> → <code>{short(d.code_rev)}</code> · {(d.payload.changed_paths as string[] | undefined)?.join(", ")}</div>
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
      <h3>Human approval</h3>
      {a && <div className="kv">
        <span>Candidate</span><code>{a.code_rev ?? str(a.payload.revision)}</code>
        <span>Tree</span><code>{str(a.payload.tree_hash)}</code>
        <span>Base</span><code>{str(a.payload.base_hash ?? v.started?.payload.base_hash)}</code>
        <span>Evidence</span><span>{(a.payload.evidence_ids as number[] | undefined)?.map((i) => `#${i}${v.staleIds.has(i) ? " (stale)" : ""}`).join(" ")}</span>
        <span>Open findings</span><span>{v.findings.filter((f) => !isResolved(f.action)).length}</span>
      </div>}
      {v.approvalResult ? <p>Decision: <strong>{approved(v.approvalResult) ? "approved" : "rejected"}</strong></p> : (
        <>
          {!v.gate.ok && <ul className="reasons">{v.gate.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          <div className="btns">
            <button className="primary" disabled={!v.gate.ok || busy} onClick={() => onDecide(true)}>Approve {short(a?.code_rev)}</button>
            <button disabled={busy || !!v.done} onClick={() => onDecide(false)}>Reject</button>
          </div>
        </>
      )}
      {error && <p className="fail">{error}</p>}
    </section>
  );
}
