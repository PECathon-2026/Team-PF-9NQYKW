import { useId } from "react";
import type { Agent } from "../lib/types";
import { col, type View } from "../lib/derive";

const CAST: { id: Agent; name: string; role: string }[] = [
  { id: "shogun", name: "Shogun", role: "Planner" },
  { id: "samurai", name: "Samurai", role: "Coder" },
  { id: "sentinel", name: "Sentinel", role: "Tester" },
  { id: "verifier", name: "Verifier", role: "Acceptance" },
  { id: "shadow_review", name: "Shadow Review", role: "Review" },
  { id: "shadow_security", name: "Shadow Security", role: "Security" },
];

/* Each emblem has its own paint servers: multiple stages can safely coexist. */
function AgentBadge({ agent, mood }: { agent: Agent; mood: string }) {
  const id = useId().replace(/:/g, "");
  const metal = `url(#${id}-metal)`;
  const dark = `url(#${id}-dark)`;
  const red = `url(#${id}-red)`;
  return (
    <svg className={`agent-badge ${mood}`} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#81786b"/><stop offset=".3" stopColor="#3c3935"/><stop offset=".7" stopColor="#171716"/><stop offset="1" stopColor="#62594f"/></linearGradient>
        <linearGradient id={`${id}-metal`} x1=".15" y1="0" x2=".85" y2="1"><stop stopColor="#e2d6c1"/><stop offset=".24" stopColor="#a79a87"/><stop offset=".5" stopColor="#71695f"/><stop offset=".75" stopColor="#b8aa94"/><stop offset="1" stopColor="#514a43"/></linearGradient>
        <linearGradient id={`${id}-dark`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#696158"/><stop offset=".35" stopColor="#302e2b"/><stop offset="1" stopColor="#151514"/></linearGradient>
        <linearGradient id={`${id}-red`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#b9654c"/><stop offset=".45" stopColor="#823e30"/><stop offset="1" stopColor="#4a2520"/></linearGradient>
        <radialGradient id={`${id}-face`}><stop stopColor="#383430"/><stop offset="1" stopColor="#1b1a19"/></radialGradient>
        <filter id={`${id}-shadow`} x="-40%" y="-40%" width="180%" height="190%"><feGaussianBlur in="SourceAlpha" stdDeviation="2"/><feOffset dy="3"/><feComponentTransfer><feFuncA type="linear" slope=".7"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <ellipse cx="50" cy="91" rx="30" ry="5" fill="#000" opacity=".38" />
      <g className="badge-art" filter={`url(#${id}-shadow)`}>
        <circle cx="50" cy="49" r="41" fill={`url(#${id}-rim)`} stroke="#100f0e" strokeWidth="2"/>
        <circle className="rim-inlay" cx="50" cy="49" r="39" fill="none" stroke="#e3d3b7" strokeOpacity=".35" strokeWidth="1"/>
        <path d="M18 39 A33 33 0 0 1 60 10" fill="none" stroke="#f4e8d5" strokeOpacity=".5" strokeWidth="1.4" strokeLinecap="round"/>
        <path d="M24 79 A39 39 0 0 0 82 72" fill="none" stroke="#070706" strokeOpacity=".8" strokeWidth="2"/>
        <circle cx="50" cy="49" r="38" fill="#171716" stroke="#8a7f6e" strokeOpacity=".35"/>
        <circle cx="50" cy="49" r="34" fill={`url(#${id}-face)`} stroke="#0e0e0e"/>
        <path d="M20 34 A34 34 0 0 1 80 34" fill="none" stroke="#ddd0bb" strokeOpacity=".22"/>
        <path d="M24 35 Q34 17 52 17" fill="none" stroke="#fff3da" strokeOpacity=".12" strokeWidth="3" strokeLinecap="round"/>
        {agent === "shogun" && <g strokeLinejoin="round" strokeLinecap="round">
          <path d="M27 50 Q27 27 50 25 Q73 27 73 50 L68 55 H32Z" fill={dark} stroke="#c1b19a" strokeWidth="1.5"/>
          <path d="M33 43 Q50 35 67 43 M50 27 V39" fill="none" stroke="#c5b49b" strokeOpacity=".75" strokeWidth="1.5"/>
          <path d="M24 20 Q29 30 42 32 M76 20 Q71 30 58 32" fill="none" stroke="#dbcbb1" strokeWidth="3.5"/>
          <path d="M50 25 L55 31 L50 37 L45 31Z" fill={red} stroke="#e0c2a8" strokeWidth="1"/>
          <path d="M27 50 Q50 42 73 50 L76 56 Q50 49 24 56Z" fill={metal} stroke="#1b1917" strokeWidth="1.5"/>
          <path d="M29 57 L25 65 L37 70 L40 61 M71 57 L75 65 L63 70 L60 61" fill={dark} stroke="#b9aa94" strokeWidth="1.2"/>
          <path d="M38 55 Q50 51 62 55 L60 65 L50 70 L40 65Z" fill="#201e1b" stroke="#c6b59c" strokeWidth="1.2"/>
          <path d="M41 57 L47 59 M59 57 L53 59 M45 64 Q50 62 55 64" fill="none" stroke="#e1cfb3" strokeWidth="1.4"/>
        </g>}
        {agent === "samurai" && <g strokeLinejoin="round">
          <path d="M30 70 L64 30 Q70 24 72 21 Q73 33 67 39 L35 74Z" fill={metal} stroke="#292622" strokeWidth="1.4"/>
          <path d="M34 68 L67 33" stroke="#eee3cf" strokeOpacity=".7"/><path d="M28 64 L38 74" stroke={red} strokeWidth="4"/><path d="M31 70 L24 78" stroke="#b4a590" strokeWidth="6" strokeLinecap="round"/><path d="M25 75 L28 78 M28 72 L31 75" stroke="#312d29" strokeWidth="1.5"/>
          <path d="M30 27 L70 67" stroke="#0e0e0e" strokeWidth="5" opacity=".6"/><path d="M28 25 L68 65" stroke={dark} strokeWidth="3"/>
        </g>}
        {agent === "sentinel" && <g strokeLinejoin="round">
          <path d="M50 20 L72 28 L70 53 Q68 68 50 78 Q32 68 30 53 L28 28Z" fill={metal} stroke="#171615" strokeWidth="2"/>
          <path d="M50 25 L67 31 L65 53 Q63 64 50 72 Q37 64 35 53 L33 31Z" fill={dark} stroke="#e2d2ba" strokeOpacity=".45"/>
          <path d="M50 30 V66 M38 39 L50 35 L62 39" fill="none" stroke="#a89b89" strokeOpacity=".55"/>
          <path d="M41 51 L47 57 L60 43" fill="none" stroke={metal} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
        </g>}
        {agent === "verifier" && <g strokeLinejoin="round">
          <path d="M31 27 L69 27 L73 32 L73 67 L68 73 L32 73 L27 68 L27 32Z" fill={metal} stroke="#24211e" strokeWidth="2"/>
          <path d="M33 32 H67 V67 H33Z" fill={dark} stroke="#d0bfa8" strokeOpacity=".5"/>
          <circle cx="50" cy="49.5" r="13" fill={red} stroke="#c09f88" strokeWidth="1.2"/><circle cx="50" cy="49.5" r="9.5" fill="none" stroke="#e1c4aa" strokeOpacity=".55"/>
          <path d="M44 50 L48 54 L57 45" fill="none" stroke="#ead9c4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M37 37 H42 M58 62 H63" stroke="#b8a994"/>
        </g>}
        {agent === "shadow_review" && <g strokeLinejoin="round" strokeLinecap="round">
          <path d="M27 38 Q30 25 50 23 Q70 25 73 38 L69 61 Q63 71 50 76 Q37 71 31 61Z" fill={metal} stroke="#171513" strokeWidth="2"/>
          <path d="M32 39 Q50 32 68 39 L65 59 Q60 67 50 71 Q40 67 35 59Z" fill={dark} stroke="#d0bda3" strokeWidth="1.2"/>
          <path d="M34 43 Q41 39 47 45 L44 48 L36 47Z M66 43 Q59 39 53 45 L56 48 L64 47Z" fill="#100f0e" stroke="#d9c4a8" strokeWidth="1.3"/>
          <path d="M50 45 L47 56 L50 58 L53 56Z" fill="#9f8e79"/>
          <path d="M42 63 Q50 59 58 63" fill="none" stroke="#d7c3aa" strokeWidth="1.4"/><path d="M50 26 V36" stroke={red} strokeWidth="3"/>
        </g>}
        {agent === "shadow_security" && <g strokeLinejoin="round">
          <path d="M23 50 Q35 30 50 30 Q65 30 77 50 Q65 70 50 70 Q35 70 23 50Z" fill={metal} stroke="#201d1b" strokeWidth="2"/>
          <path d="M28 50 Q38 36 50 36 Q62 36 72 50 Q62 64 50 64 Q38 64 28 50Z" fill={dark} stroke="#c0af99" strokeOpacity=".5"/>
          <circle cx="50" cy="50" r="11" fill={red} stroke="#bca38e"/><circle cx="50" cy="50" r="6" fill="#1b1918"/><circle cx="47" cy="47" r="2" fill="#e8d6bd" opacity=".8"/>
          <path d="M35 29 L39 25 M65 29 L61 25 M35 71 L39 75 M65 71 L61 75" stroke="#9b8d7a" strokeWidth="1.5"/>
        </g>}
      </g>
    </svg>
  );
}

function moodOf(v: View, a: Agent, now: number): string {
  if (v.done) return v.state === "COMPLETED" ? "done" : "idle";
  const mine = v.events.filter((e) => e.agent === a);
  const last = mine[mine.length - 1];
  if (last && last.type === "test_result" && last.payload.outcome !== "passed" && now - last.ts < 4000) return "failed";
  if (last && now - last.ts < 2500) return "work";
  if (v.tasks.some((t) => col(t.status) === "running" && t.role === a)) return "work";
  return "idle";
}

function lineOf(v: View, a: Agent): string {
  const mine = v.events.filter((e) => e.agent === a); const e = mine[mine.length - 1];
  return e ? e.type.replace(/_/g, " ") : "waiting";
}

function TurnMeter({ v, a }: { v: View; a: Agent }) {
  const usage = v.usage?.per_agent[a]; const used = usage?.pass_turns ?? usage?.turns; const cap = v.budget?.[a];
  if (used === undefined && cap === undefined) return null;
  const u = used ?? 0;
  if (cap === undefined || (usage?.pass_turns === undefined && u > cap)) return <small className="turns">{u} turns</small>;
  const pct = cap > 0 ? Math.min(100, (u / cap) * 100) : 100;
  return <small className={`turns${u >= cap ? " spent" : u >= cap - 1 ? " low" : ""}`} title={`${u} of ${cap} turns used`}>
    {u}/{cap} turns<span className="tbar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
  </small>;
}

export function Dojo({ v, now }: { v: View; now: number }) {
  return (
    <section className="dojo" aria-label="Agent stage">
      <div className="cast">
        {CAST.map((c) => {
          const mood = moodOf(v, c.id, now);
          return <figure key={c.id} className={`actor m-${mood}`}>
            <AgentBadge agent={c.id} mood={mood} />
            <figcaption><strong>{c.name}</strong><span className="role">{c.role.toLowerCase()}</span>{(mood === "work" || mood === "failed") && <em>{mood === "work" ? lineOf(v, c.id) : "check failed"}</em>}<TurnMeter v={v} a={c.id} /></figcaption>
          </figure>;
        })}
      </div>
    </section>
  );
}
