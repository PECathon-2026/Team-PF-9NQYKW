import { useState } from "react";
import { fetchEventsOnce } from "../lib/api";
import { derive, str, type View } from "../lib/derive";
import { fmtTok } from "./Panels";

// Compares two REAL recorded missions loaded from the server. No placeholder numbers.
export function Comparison({ disabled }: { disabled: boolean }) {
  const [ids, setIds] = useState({ multi: "", base: "" });
  const [rows, setRows] = useState<{ multi: View; base: View } | null>(null);
  const [err, setErr] = useState("");
  const load = async () => {
    setErr(""); setRows(null);
    const b = await fetchEventsOnce(ids.base.trim());
    if (!b.length) return setErr("Baseline mission returned no events.");
    if (!b.some((e) => e.agent === "baseline" || (e.type === "mission_started" && e.payload.mode === "baseline"))) return setErr("That mission has no baseline-agent events; it is not a baseline run.");
    const bv = derive(b);
    // Auto-pair from paired_mission_id; manual multi-agent id is the fallback.
    const multiId = bv.pairedMissionId ?? ids.multi.trim();
    if (!multiId) return setErr("Baseline has no paired_mission_id; enter the multi-agent mission id manually.");
    if (bv.pairedMissionId && ids.multi.trim() && ids.multi.trim() !== bv.pairedMissionId) setErr(`Using paired_mission_id ${bv.pairedMissionId} (overrides manual entry).`);
    setIds((x) => ({ ...x, multi: multiId }));
    const m = await fetchEventsOnce(multiId);
    if (!m.length) return setErr(`Multi-agent mission ${multiId} returned no events.`);
    setRows({ multi: derive(m), base: bv });
  };
  const metric = (v: View): [string, string][] => {
    const t0 = v.events[0]?.ts, t1 = v.events[v.events.length - 1]?.ts;
    return [
      ["Terminal outcome", v.done ? str(v.done.payload.status) : "not finished"],
      ["Reached approval gate", v.pendingApproval ? "yes" : "no"],
      ["Project checks (latest, observed)", v.checks.filter((c) => c.kind === "check" && c.event.verified).map((c) => `${c.key}: ${c.outcome}`).join(", ") || "none"],
      ["Acceptance (latest, observed)", v.checks.filter((c) => c.kind === "acceptance" && c.event.verified).map((c) => `${c.key}: ${c.outcome}`).join(", ") || "none"],
      ["Open findings", String(v.findings.filter((f) => f.action !== "resolve" && f.action !== "resolved").length)],
      ["Fix cycles (revisions − 1)", String(v.fixCycles)],
      ["Tool failures", String(v.toolFailures)],
      ["Model turns", v.usage ? String(v.usage.total.turns) : "not reported"],
      ["Tokens (in / out)", v.usage ? `${fmtTok(v.usage.total.input_tokens)} / ${fmtTok(v.usage.total.output_tokens)}` : "not reported"],
      ["Unisolated results", String(v.unisolated.size)],
      ["Elapsed", t0 && t1 ? `${((t1 - t0) / 1000).toFixed(1)}s` : "—"],
      ["Base hash", str(v.started?.payload.base_hash, "—")],
    ];
  };
  return (
    <section className="card">
      <h3>Baseline vs multi-agent</h3>
      {disabled ? <p className="muted">Unavailable in demo replay: comparison uses recorded real runs only.</p> : (
        <>
          <div className="row">
            <input placeholder="Baseline mission id" value={ids.base} onChange={(e) => setIds({ ...ids, base: e.target.value })} />
            <input placeholder="Multi-agent id (auto from paired_mission_id)" value={ids.multi} onChange={(e) => setIds({ ...ids, multi: e.target.value })} />
            <button disabled={!ids.base} onClick={load}>Load</button>
          </div>
          {err && <p className="fail">{err}</p>}
          {rows && (
            <table className="tbl">
              <thead><tr><th></th><th>Multi-agent</th><th>Baseline</th></tr></thead>
              <tbody>{metric(rows.multi).map(([k, a], i) => <tr key={k}><td>{k}</td><td>{a}</td><td>{metric(rows.base)[i][1]}</td></tr>)}</tbody>
            </table>
          )}
          {rows && str(rows.multi.started?.payload.base_hash) !== str(rows.base.started?.payload.base_hash) && <p className="warn">Base hashes differ: runs are not from the same seed.</p>}
          <p className="muted small">Turns and tokens come from the latest usage event; unisolated results are excluded from verified evidence.</p>
        </>
      )}
    </section>
  );
}
