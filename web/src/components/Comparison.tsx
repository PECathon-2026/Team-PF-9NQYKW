import { useState } from "react";
import { fetchEventsOnce } from "../lib/api";
import { derive, str, type View } from "../lib/derive";
import { fmtTok } from "./Panels";
import { checkLabel, stateLabel } from "../lib/labels";

// Compares two REAL recorded missions loaded from the server. No placeholder numbers.
export function Comparison({ disabled }: { disabled: boolean }) {
  const [ids, setIds] = useState({ multi: "", base: "" });
  const [rows, setRows] = useState<{ multi: View; base: View } | null>(null);
  const [err, setErr] = useState("");
  const load = async () => {
    setErr(""); setRows(null);
    const b = await fetchEventsOnce(ids.base.trim());
    if (!b.length) return setErr("No events found for that baseline mission.");
    if (!b.some((e) => e.agent === "baseline" || (e.type === "mission_started" && e.payload.mode === "baseline"))) return setErr("That mission is not a baseline run.");
    const bv = derive(b);
    // Auto-pair from paired_mission_id; manual multi-agent id is the fallback.
    const multiId = bv.pairedMissionId ?? ids.multi.trim();
    if (!multiId) return setErr("This baseline has no paired mission. Enter the multi-agent mission ID.");
    if (bv.pairedMissionId && ids.multi.trim() && ids.multi.trim() !== bv.pairedMissionId) setErr(`Using the paired mission ${bv.pairedMissionId} instead of the ID entered.`);
    setIds((x) => ({ ...x, multi: multiId }));
    const m = await fetchEventsOnce(multiId);
    if (!m.length) return setErr(`No events found for multi-agent mission ${multiId}.`);
    setRows({ multi: derive(m), base: bv });
  };
  const metric = (v: View): [string, string][] => {
    const t0 = v.events[0]?.ts, t1 = v.events[v.events.length - 1]?.ts;
    return [
      ["Outcome", v.done ? stateLabel(str(v.done.payload.status)) : "Not finished"],
      ["Reached approval", v.pendingApproval ? "Yes" : "No"],
      ["Visible tests and checks", v.checks.filter((c) => c.kind === "check" && c.event.verified).map((c) => `${checkLabel(c.key, c.kind)}: ${c.outcome} (ID: ${c.key})`).join(", ") || "None"],
      ["Hidden acceptance tests", v.checks.filter((c) => c.kind === "acceptance" && c.event.verified).map((c) => `${checkLabel(c.key, c.kind)}: ${c.outcome} (ID: ${c.key})`).join(", ") || "None"],
      ["Open findings", String(v.findings.filter((f) => f.action !== "resolve" && f.action !== "resolved").length)],
      ["Tamper attempts blocked", String(v.tampers.length)],
      ["Fix rounds used", String(v.fixCycles)],
      ["Tool failures", String(v.toolFailures)],
      ["Model turns", v.usage ? String(v.usage.total.turns) : "Not reported"],
      ["Tokens in / out", v.usage ? `${fmtTok(v.usage.total.input_tokens)} / ${fmtTok(v.usage.total.output_tokens)}` : "Not reported"],
      ["Results without a protected environment", String(v.unisolated.size)],
      ["Elapsed", t0 && t1 ? `${((t1 - t0) / 1000).toFixed(1)}s` : "—"],
      ["Original repository snapshot", str(v.started?.payload.base_hash, "—")],
    ];
  };
  return (
    <section className="card">
      {disabled ? <p className="muted">Not available in demo replay. Comparison uses recorded real runs only.</p> : (
        <>
          <div className="row">
            <input aria-label="Baseline mission ID" placeholder="Baseline mission ID" value={ids.base} onChange={(e) => setIds({ ...ids, base: e.target.value })} />
            <input aria-label="Multi-agent mission ID" placeholder="Multi-agent mission ID (optional if paired)" value={ids.multi} onChange={(e) => setIds({ ...ids, multi: e.target.value })} />
            <button className="primary" disabled={!ids.base} onClick={load}>Compare</button>
          </div>
          {err && <p className="fail">{err}</p>}
          {rows && (
            <table className="tbl">
              <thead><tr><th></th><th>Multi-agent</th><th>Baseline</th></tr></thead>
              <tbody>{metric(rows.multi).map(([k, a], i) => <tr key={k} className={k === "Original repository snapshot" ? "mono-row" : ""}><td>{k}</td><td>{a}</td><td>{metric(rows.base)[i][1]}</td></tr>)}</tbody>
            </table>
          )}
          {rows && str(rows.multi.started?.payload.base_hash) !== str(rows.base.started?.payload.base_hash) && <p className="warn">The original repository snapshots differ. These runs did not start from the same code.</p>}
          <p className="muted small">Checks show the latest observed result. Turns and tokens come from the latest usage report. Results without a protected environment never count toward approval.</p>
        </>
      )}
    </section>
  );
}
