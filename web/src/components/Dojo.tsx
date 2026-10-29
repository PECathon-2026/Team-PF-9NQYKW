import { useEffect, useState } from "react";
import type { Agent, MissionEvent } from "../lib/types";
import { approved, col, isResolved, type View } from "../lib/derive";

// Small SVG samurai per agent. Colors/props distinguish roles; all labels are text nodes.
const CAST: { id: Agent; name: string; role: string; armor: string; prop: "fan" | "katana" | "bow" | "scroll" | "lantern" | "shield" }[] = [
  { id: "shogun", name: "Shogun", role: "planner", armor: "#b3261e", prop: "fan" },
  { id: "samurai", name: "Samurai", role: "coder", armor: "#1f1a17", prop: "katana" },
  { id: "sentinel", name: "Sentinel", role: "tester", armor: "#4a5d3a", prop: "bow" },
  { id: "verifier", name: "Verifier", role: "acceptance", armor: "#2f4a5c", prop: "scroll" },
  { id: "shadow_review", name: "Shadow R.", role: "review", armor: "#4b3a5e", prop: "lantern" },
  { id: "shadow_security", name: "Shadow S.", role: "security", armor: "#5c2a2a", prop: "shield" },
];

function Prop({ kind }: { kind: string }) {
  switch (kind) {
    case "katana": return <g className="prop sword"><rect x="44" y="20" width="3" height="34" rx="1.5" fill="#d9d4c7" stroke="#1f1a17" strokeWidth="1" /><rect x="41" y="52" width="9" height="3" fill="#b3261e" /><rect x="44" y="55" width="3" height="8" fill="#1f1a17" /></g>;
    case "fan": return <g className="prop"><path d="M44 50 L36 30 Q46 24 56 30 Z" fill="#f3e6c8" stroke="#1f1a17" strokeWidth="1.2" /><circle cx="46" cy="33" r="3" fill="#b3261e" /></g>;
    case "bow": return <g className="prop"><path d="M48 22 Q60 44 48 66" fill="none" stroke="#6b4a2b" strokeWidth="2.2" /><line x1="48" y1="22" x2="48" y2="66" stroke="#1f1a17" strokeWidth=".8" /></g>;
    case "scroll": return <g className="prop"><rect x="40" y="44" width="16" height="10" rx="2" fill="#f3e6c8" stroke="#1f1a17" strokeWidth="1.2" /><line x1="44" y1="48" x2="52" y2="48" stroke="#1f1a17" strokeWidth=".8" /></g>;
    case "lantern": return <g className="prop"><line x1="48" y1="34" x2="48" y2="42" stroke="#1f1a17" /><ellipse cx="48" cy="49" rx="6" ry="8" fill="#e8743b" stroke="#1f1a17" strokeWidth="1.2" className="glow" /></g>;
    default: return <g className="prop"><path d="M40 40 h16 v10 q-8 10 -16 0 z" fill="#d9d4c7" stroke="#1f1a17" strokeWidth="1.2" /><circle cx="48" cy="45" r="2.5" fill="#b3261e" /></g>;
  }
}

function Chibi({ armor, prop, mood }: { armor: string; prop: string; mood: string }) {
  return (
    <svg viewBox="0 0 64 80" className={`chibi ${mood}`} aria-hidden="true">
      <ellipse cx="32" cy="76" rx="16" ry="3" fill="#1f1a17" opacity=".15" />
      <g className="body">
        {/* legs */}<rect x="22" y="58" width="7" height="14" rx="2" fill="#1f1a17" /><rect x="35" y="58" width="7" height="14" rx="2" fill="#1f1a17" />
        {/* armor */}<path d="M16 44 q16 -8 32 0 l-3 18 h-26 z" fill={armor} stroke="#1f1a17" strokeWidth="1.5" />
        <path d="M20 50 h24 M21 55 h22" stroke="#f3e6c8" strokeWidth="1" opacity=".5" />
        {/* head */}<circle cx="32" cy="30" r="15" fill="#f6dcc0" stroke="#1f1a17" strokeWidth="1.5" />
        {/* kabuto helmet */}<path d="M15 28 q17 -22 34 0 q-17 -6 -34 0z" fill={armor} stroke="#1f1a17" strokeWidth="1.5" />
        <path d="M24 12 L32 20 L40 12" fill="none" stroke="#c9a227" strokeWidth="2.2" strokeLinecap="round" />
        {/* face */}<g className="eyes"><ellipse cx="26.5" cy="32" rx="1.8" ry="2.2" fill="#1f1a17" /><ellipse cx="37.5" cy="32" rx="1.8" ry="2.2" fill="#1f1a17" /></g>
        <circle cx="23" cy="36" r="2" fill="#e88" opacity=".5" /><circle cx="41" cy="36" r="2" fill="#e88" opacity=".5" />
        <path d={mood === "sad" ? "M29 39 q3 -2 6 0" : "M29 38 q3 2.5 6 0"} fill="none" stroke="#1f1a17" strokeWidth="1.2" strokeLinecap="round" />
        <g className="arm"><Prop kind={prop} /></g>
      </g>
      <g className="zzz"><text x="48" y="14">z</text><text x="53" y="8">z</text></g>
    </svg>
  );
}

/** Mood per agent: working if it emitted recently or owns a running task; sad on a failure it owns. */
function moodOf(v: View, a: Agent, now: number): string {
  if (v.done) return v.state === "COMPLETED" ? "joy" : "idle";
  const mine = v.events.filter((e) => e.agent === a);
  const last = mine[mine.length - 1];
  if (last && last.type === "test_result" && last.payload.outcome !== "passed" && now - last.ts < 4000) return "sad";
  if (last && now - last.ts < 2500) return "work";
  if (v.tasks.some((t) => col(t.status) === "running" && t.role === a)) return "work";
  return "idle";
}

function lineOf(v: View, a: Agent): string {
  const mine = v.events.filter((e) => e.agent === a); const e = mine[mine.length - 1];
  if (!e) return "waiting";
  return e.type.replace(/_/g, " ");
}

/** Per-role turns: "used/budget" with a bar when the backend sends a budget, else just "used" (omitted if never used). */
function TurnMeter({ v, a }: { v: View; a: Agent }) {
  const used = v.usage?.per_agent[a]?.turns; const cap = v.budget?.[a];
  if (used === undefined && cap === undefined) return null;
  const u = used ?? 0;
  if (cap === undefined) return <small className="turns">{u} turns</small>;
  const pct = cap > 0 ? Math.min(100, (u / cap) * 100) : 100;
  return (
    <small className={`turns${u >= cap ? " spent" : u >= cap - 1 ? " low" : ""}`} title={`${u} of ${cap} turns used`}>
      {u}/{cap} turns<span className="tbar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
    </small>
  );
}

const str2 = (x: unknown) => (typeof x === "string" ? x : "");
export function Dojo({ v, now }: { v: View; now: number }) {
  const [slash, setSlash] = useState<{ key: number; who: Agent } | null>(null);
  const last: MissionEvent | undefined = v.events[v.events.length - 1];
  useEffect(() => {
    if (!last) return;
    const win = (last.type === "test_result" && last.payload.outcome === "passed") || (last.type === "finding" && isResolved(str2(last.payload.action)));
    if (win) { setSlash({ key: last.id, who: last.agent }); const t = setTimeout(() => setSlash(null), 1100); return () => clearTimeout(t); }
  }, [last]);
  const sealed = approved(v.approvalResult);
  return (
    <section className="dojo" aria-label="Agent stage">
      <div className="beam" /><div className="noren"><span>道場</span></div>
      <div className="cast">
        {CAST.map((c) => {
          const mood = moodOf(v, c.id, now);
          return (
            <figure key={c.id} className={`actor m-${mood}`}>
              {slash?.who === c.id && <svg key={slash.key} className="slash" viewBox="0 0 100 100" aria-hidden="true"><path d="M8 82 Q50 50 94 14" /></svg>}
              <Chibi armor={c.armor} prop={c.prop} mood={mood} />
              <figcaption><strong>{c.name}</strong><span>{c.role}</span><TurnMeter v={v} a={c.id} /><em>{mood === "work" ? lineOf(v, c.id) : mood === "sad" ? "check failed" : mood === "joy" ? "victory" : "resting"}</em></figcaption>
            </figure>
          );
        })}
      </div>
      <div className="tatami" />
      {sealed && <div className="hanko" role="img" aria-label="Approved seal"><span>承認</span></div>}
    </section>
  );
}
