import type { CSSProperties } from "react";
import { Crown, Eye, LockKeyhole, ScrollText, Shield, Sword, type LucideIcon } from "lucide-react";
import shogun from "../assets/agents/shogun@192.webp";
import samurai from "../assets/agents/samurai@192.webp";
import sentinel from "../assets/agents/sentinel@192.webp";
import verifier from "../assets/agents/verifier@192.webp";
import shadowReview from "../assets/agents/shadow_review@192.webp";
import shadowSecurity from "../assets/agents/shadow_security@192.webp";
import type { Agent } from "../lib/types";
import { agentTurns, stageState, type View } from "../lib/derive";
import { AGENT_NAMES, agentRole } from "../lib/labels";

export type FigureAgent = "shogun" | "samurai" | "sentinel" | "verifier" | "shadow_review" | "shadow_security";
export const CAST: { id: FigureAgent; name: string; role: string }[] =
  (["shogun", "samurai", "sentinel", "verifier", "shadow_review", "shadow_security"] as FigureAgent[])
    .map((id) => ({ id, name: AGENT_NAMES[id], role: agentRole(id) }));
// 192px-tall art rendered at 96px, so one asset covers 1x and 2x displays.
const FIGURES: Record<FigureAgent, string> = { shogun, samurai, sentinel, verifier, shadow_review: shadowReview, shadow_security: shadowSecurity };
const ROLE_MARKS: Record<FigureAgent, { icon: LucideIcon; accent: string }> = {
  shogun: { icon: Crown, accent: "#ac5761" },
  samurai: { icon: Sword, accent: "#c0745e" },
  sentinel: { icon: Shield, accent: "#af8c59" },
  verifier: { icon: ScrollText, accent: "#b9a780" },
  shadow_review: { icon: Eye, accent: "#a383a1" },
  shadow_security: { icon: LockKeyhole, accent: "#7f989a" },
};
const STATUS = { idle: "Idle", work: "Working", done: "Done", failed: "Failed" } as const;
function turns(v: View, a: Agent) {
  const used = agentTurns(v.usage, a); const cap = v.budget?.[a];
  if (used === undefined && cap === undefined) return null;
  const u = used ?? 0;
  if (cap === undefined || u > cap) return { label: `${u} turns`, level: "", title: undefined };
  return { label: `${u}/${cap} turns`, level: u >= cap ? "spent" : u >= cap - 1 ? "low" : "", title: `${u} of ${cap} turns used` };
}
export function Dojo({ v, now, selected, onSelect }: { v: View; now: number; selected: string; onSelect: (id: FigureAgent) => void }) {
  const repoTests = v.events.some((e) => e.type === "mission_started" && e.payload.acceptance_mode === "repo_tests");
  const handoff = [...v.events].reverse().find((e) => e.type === "agent_msg" && now - e.ts < 5000);
  const handoffFrom = handoff ? CAST.findIndex((a) => a.id === handoff.agent) : -1;
  const handoffTo = handoff ? CAST.findIndex((a) => a.id === (handoff.payload.to ?? handoff.payload.recipient)) : -1;
  const handoffPath = handoffFrom >= 0 && handoffTo >= 0 && handoffFrom !== handoffTo
    ? handoffFrom === 3 && handoffTo >= 4
      ? `M700 7 H770 V${handoffTo === 4 ? 2 : 12} H${100 + handoffTo * 200}`
      : `M${100 + handoffFrom * 200} 7 H${100 + handoffTo * 200}`
    : null;
  return <section className="dojo" aria-label="Agent pipeline">
    <div className="cast">
      <div className="pipeline-line" aria-hidden="true"><svg viewBox="0 0 1200 14" preserveAspectRatio="none"><path d="M100 7 H700 M700 7 H770 M770 7 V2 H900 M770 7 V12 H1100" /><circle cx="770" cy="7" r="3" className="fork-node" />{handoffPath && <circle className="handoff-pulse" r="3.5" key={handoff?.id}><animateMotion dur="2.5s" path={handoffPath} repeatCount="1" fill="freeze" /></circle>}</svg></div>
      {CAST.map((c) => {
        const mood = stageState(v.events, c.id, now); const art = FIGURES[c.id]; const t = turns(v, c.id);
        const { icon: RoleIcon, accent } = ROLE_MARKS[c.id];
        const style = c.id === "samurai" ? { "--figure-mask": `url("${art}")` } as CSSProperties : undefined;
        return <button type="button" key={c.id} className={`actor m-${mood} ${selected === c.id ? "selected" : ""}`} style={{ "--role-accent": accent } as CSSProperties} onClick={() => onSelect(c.id)} aria-pressed={selected === c.id} aria-label={`${c.name}: ${(repoTests && c.id === "verifier" ? "Runs the repository's own tests" : c.role).toLowerCase()}. ${STATUS[mood]}. Show activity`} title={`${(repoTests && c.id === "verifier" ? "Runs the repository's own tests" : c.role)}. Select to show activity.`}>
          <span className={`agent-figure ${mood}`} aria-hidden="true"><span className="figure-mist" /><span className={`figure-art${c.id === "samurai" ? " samurai" : ""}`} style={style}><img src={art} alt="" /></span></span>
          <span className="actor-title"><RoleIcon size={12} aria-hidden="true" focusable="false" /><span>{c.name}</span></span>
          <span className="actor-role">{(repoTests && c.id === "verifier" ? "Runs the repository's own tests" : c.role)}</span>
          <span className={`actor-status status-${mood}`}>{STATUS[mood]}{t && <span className={`turns ${t.level}`} title={t.title}> · {t.label}</span>}</span>
        </button>;
      })}
    </div>
  </section>;
}
