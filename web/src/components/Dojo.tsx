import type { CSSProperties } from "react";
import { ArrowUpRight, CheckCircle2, Circle, CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import shogun from "../assets/agents/shogun.webp";
import shogun192 from "../assets/agents/shogun@192.webp";
import samurai from "../assets/agents/samurai.webp";
import samurai192 from "../assets/agents/samurai@192.webp";
import sentinel from "../assets/agents/sentinel.webp";
import sentinel192 from "../assets/agents/sentinel@192.webp";
import verifier from "../assets/agents/verifier.webp";
import verifier192 from "../assets/agents/verifier@192.webp";
import shadowReview from "../assets/agents/shadow_review.webp";
import shadowReview192 from "../assets/agents/shadow_review@192.webp";
import shadowSecurity from "../assets/agents/shadow_security.webp";
import shadowSecurity192 from "../assets/agents/shadow_security@192.webp";
import type { Agent } from "../lib/types";
import { stageState, str, type View } from "../lib/derive";
import { summary } from "./Panels";

export type FigureAgent = "shogun" | "samurai" | "sentinel" | "verifier" | "shadow_review" | "shadow_security";
export const CAST: { id: FigureAgent; name: string; role: string }[] = [
  { id: "shogun", name: "Shogun", role: "Planner" }, { id: "samurai", name: "Samurai", role: "Coder" },
  { id: "sentinel", name: "Sentinel", role: "Tester" }, { id: "verifier", name: "Verifier", role: "Acceptance" },
  { id: "shadow_review", name: "Shadow Review", role: "Review" }, { id: "shadow_security", name: "Shadow Security", role: "Security" },
];
const FIGURES: Record<FigureAgent, { full: string; small: string }> = {
  shogun: { full: shogun, small: shogun192 }, samurai: { full: samurai, small: samurai192 },
  sentinel: { full: sentinel, small: sentinel192 }, verifier: { full: verifier, small: verifier192 },
  shadow_review: { full: shadowReview, small: shadowReview192 }, shadow_security: { full: shadowSecurity, small: shadowSecurity192 },
};
function TurnMeter({ v, a }: { v: View; a: Agent }) {
  const usage = v.usage?.per_agent[a]; const used = usage?.pass_turns ?? usage?.turns; const cap = v.budget?.[a];
  if (used === undefined && cap === undefined) return null;
  const u = used ?? 0;
  if (cap === undefined || u > cap) return <small className="turns">{u} turns</small>;
  const pct = cap > 0 ? Math.min(100, (u / cap) * 100) : 100;
  return <small className={`turns${u >= cap ? " spent" : u >= cap - 1 ? " low" : ""}`} title={`${u} of ${cap} turns used`}>
    {u}/{cap} turns<span className="tbar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
  </small>;
}
export function Dojo({ v, now, selected, onSelect }: { v: View; now: number; selected: string; onSelect: (id: FigureAgent) => void }) {
  const handoff = [...v.events].reverse().find((e) => e.type === "agent_msg" && now - e.ts < 5000);
  const handoffFrom = handoff ? CAST.findIndex((a) => a.id === handoff.agent) : -1;
  const handoffTo = handoff ? CAST.findIndex((a) => a.id === (handoff.payload.to ?? handoff.payload.recipient)) : -1;
  const handoffPath = handoffFrom >= 0 && handoffTo >= 0 && handoffFrom !== handoffTo
    ? handoffFrom === 3 && handoffTo >= 4
      ? `M700 16 H770 V${handoffTo === 4 ? 4 : 30} H${100 + handoffTo * 200}`
      : `M${100 + handoffFrom * 200} 16 H${100 + handoffTo * 200}`
    : null;
  return <section className="dojo" aria-label="Agent pipeline">
    <div className="pipeline-heading"><div><span className="eyebrow">Execution pipeline</span><h2>Mission control</h2></div><span className="pipeline-note">Select an agent to inspect activity <ArrowUpRight size={13} /></span></div>
    <div className="cast">
      <div className="pipeline-line" aria-hidden="true"><svg viewBox="0 0 1200 34" preserveAspectRatio="none"><path d="M100 16 H700 M700 16 H770 M770 16 V4 H900 M770 16 V30 H1100" /><circle cx="770" cy="16" r="3" className="fork-node" />{handoffPath && <circle className="handoff-pulse" r="4" key={handoff?.id}><animateMotion dur="2.5s" path={handoffPath} repeatCount="1" fill="freeze" /></circle>}</svg></div>
      {CAST.map((c, i) => {
        const mood = stageState(v.events, c.id, now); const figure = FIGURES[c.id];
        const latest = [...v.events].reverse().find((e) => e.agent === c.id && e.type !== "usage");
        const detail = latest ? summary(latest) : "Awaiting activity";
        const StatusIcon = mood === "work" ? LoaderCircle : mood === "done" ? CheckCircle2 : mood === "failed" ? CircleAlert : Circle;
        const status = mood === "work" ? "Working" : mood === "done" ? "Done" : mood === "failed" ? "Failed" : "Idle";
        const style = c.id === "samurai" ? { "--figure-mask": `url("${figure.full}")` } as CSSProperties : undefined;
        return <button type="button" key={c.id} className={`actor m-${mood} ${selected === c.id ? "selected" : ""}`} onClick={() => onSelect(c.id)} aria-pressed={selected === c.id} aria-label={`${c.name}, ${status}, filter activity`}>
          <span className="stage-number">{String(i + 1).padStart(2, "0")}</span>
          <span className={`agent-figure ${mood}`} aria-hidden="true"><span className="figure-mist" /><span className={`figure-art${c.id === "samurai" ? " samurai" : ""}`} style={style}><img src={figure.small} srcSet={`${figure.small} 1x, ${figure.full} 2x`} alt="" /></span></span>
          <span className="actor-info"><span className="actor-title">{c.name}</span><span className={`actor-status status-${mood}`}><StatusIcon size={11} />{status} <span className="role">· {c.role}</span></span><span className="agent-current" title={detail}><Wrench size={11} /><span>{latest ? str(detail, "Activity recorded") : detail}</span></span><TurnMeter v={v} a={c.id} /></span>
        </button>;
      })}
    </div>
  </section>;
}
