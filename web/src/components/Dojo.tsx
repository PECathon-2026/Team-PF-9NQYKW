import type { CSSProperties } from "react";
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
import { col, type View } from "../lib/derive";

type FigureAgent = "shogun" | "samurai" | "sentinel" | "verifier" | "shadow_review" | "shadow_security";

const CAST: { id: FigureAgent; name: string; role: string }[] = [
  { id: "shogun", name: "Shogun", role: "Planner" },
  { id: "samurai", name: "Samurai", role: "Coder" },
  { id: "sentinel", name: "Sentinel", role: "Tester" },
  { id: "verifier", name: "Verifier", role: "Acceptance" },
  { id: "shadow_review", name: "Shadow Review", role: "Review" },
  { id: "shadow_security", name: "Shadow Security", role: "Security" },
];

const FIGURES: Record<FigureAgent, { full: string; small: string }> = {
  shogun: { full: shogun, small: shogun192 },
  samurai: { full: samurai, small: samurai192 },
  sentinel: { full: sentinel, small: sentinel192 },
  verifier: { full: verifier, small: verifier192 },
  shadow_review: { full: shadowReview, small: shadowReview192 },
  shadow_security: { full: shadowSecurity, small: shadowSecurity192 },
};

function AgentFigure({ agent, mood }: { agent: FigureAgent; mood: string }) {
  const figure = FIGURES[agent];
  const style = agent === "samurai"
    ? { "--figure-mask": `url("${figure.full}")` } as CSSProperties
    : undefined;
  return (
    <div className={`agent-figure ${mood}`} aria-hidden="true">
      <span className="figure-mist" />
      <div className={`figure-art${agent === "samurai" ? " samurai" : ""}`} style={style}>
        <img src={figure.small} srcSet={`${figure.small} 1x, ${figure.full} 2x`} alt="" />
      </div>
    </div>
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
            <AgentFigure agent={c.id} mood={mood} />
            <figcaption><strong>{c.name}</strong><span className="role">{c.role.toLowerCase()}</span>{(mood === "work" || mood === "failed") && <em>{mood === "work" ? lineOf(v, c.id) : "check failed"}</em>}<TurnMeter v={v} a={c.id} /></figcaption>
          </figure>;
        })}
      </div>
    </section>
  );
}
