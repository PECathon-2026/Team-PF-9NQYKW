import type { CSSProperties } from "react";
import shogun from "../assets/agents/shogun@192.webp";
import samurai from "../assets/agents/samurai@192.webp";
import sentinel from "../assets/agents/sentinel@192.webp";
import verifier from "../assets/agents/verifier@192.webp";
import shadowReview from "../assets/agents/shadow_review@192.webp";
import shadowSecurity from "../assets/agents/shadow_security@192.webp";
import type { Agent } from "../lib/types";
import { stageState, type View } from "../lib/derive";
import { AGENT_NAMES } from "../lib/labels";

export type FigureAgent = "shogun" | "samurai" | "sentinel" | "verifier" | "shadow_review" | "shadow_security";
export const CAST: { id: FigureAgent; name: string; role: string }[] = [
  { id: "shogun", role: "Plans the mission" }, { id: "samurai", role: "Writes the code" },
  { id: "sentinel", role: "Runs project checks" }, { id: "verifier", role: "Runs the acceptance suite" },
  { id: "shadow_review", role: "Reviews the code" }, { id: "shadow_security", role: "Reviews for security" },
].map((c) => ({ ...c, id: c.id as FigureAgent, name: AGENT_NAMES[c.id as FigureAgent] }));
// 192px-tall art rendered at 96px, so one asset covers 1x and 2x displays.
const FIGURES: Record<FigureAgent, string> = { shogun, samurai, sentinel, verifier, shadow_review: shadowReview, shadow_security: shadowSecurity };
const STATUS = { idle: "Idle", work: "Working", done: "Done", failed: "Failed" } as const;
function turns(v: View, a: Agent) {
  const usage = v.usage?.per_agent[a]; const used = usage?.pass_turns ?? usage?.turns; const cap = v.budget?.[a];
  if (used === undefined && cap === undefined) return null;
  const u = used ?? 0;
  if (cap === undefined || u > cap) return { label: `${u} turns`, level: "", title: undefined };
  return { label: `${u}/${cap} turns`, level: u >= cap ? "spent" : u >= cap - 1 ? "low" : "", title: `${u} of ${cap} turns used` };
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
    <div className="cast">
      <div className="pipeline-line" aria-hidden="true"><svg viewBox="0 0 1200 34" preserveAspectRatio="none"><path d="M100 16 H700 M700 16 H770 M770 16 V4 H900 M770 16 V30 H1100" /><circle cx="770" cy="16" r="3" className="fork-node" />{handoffPath && <circle className="handoff-pulse" r="3.5" key={handoff?.id}><animateMotion dur="2.5s" path={handoffPath} repeatCount="1" fill="freeze" /></circle>}</svg></div>
      {CAST.map((c) => {
        const mood = stageState(v.events, c.id, now); const art = FIGURES[c.id]; const t = turns(v, c.id);
        const style = c.id === "samurai" ? { "--figure-mask": `url("${art}")` } as CSSProperties : undefined;
        return <button type="button" key={c.id} className={`actor m-${mood} ${selected === c.id ? "selected" : ""}`} onClick={() => onSelect(c.id)} aria-pressed={selected === c.id} aria-label={`${c.name}: ${c.role.toLowerCase()}. ${STATUS[mood]}. Show activity`} title={`${c.role}. Select to show activity.`}>
          <span className={`agent-figure ${mood}`} aria-hidden="true"><span className="figure-mist" /><span className={`figure-art${c.id === "samurai" ? " samurai" : ""}`} style={style}><img src={art} alt="" /></span></span>
          <span className="actor-title">{c.name}</span>
          <span className={`actor-status status-${mood}`}>{STATUS[mood]}{t && <span className={`turns ${t.level}`} title={t.title}> · {t.label}</span>}</span>
        </button>;
      })}
    </div>
  </section>;
}
