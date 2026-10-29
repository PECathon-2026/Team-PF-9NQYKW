import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { approve, createMission, subscribe } from "./lib/api";
import { derive } from "./lib/derive";
import { assertValid, decisionEvents, stockScript, titlesScript } from "./lib/replay";
import { REQUESTS } from "./lib/requests";
import { REPOS, type MissionEvent, type RepoId } from "./lib/types";
import { Approval, DiffViewer, Escalation, Evidence, Header, TaskBoard, Timeline } from "./components/Panels";
import { Comparison } from "./components/Comparison";
import { Dojo } from "./components/Dojo";
import { Background } from "./components/Background";

const DEV = import.meta.env.DEV;
type Mode = "live" | "replay";

export default function App() {
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<Mode>(DEV && params.get("replay") ? "replay" : "live");
  const [repo, setRepo] = useState<RepoId>((params.get("repo") as RepoId) || "stock");
  const [request, setRequest] = useState(REQUESTS[repo]);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [conn, setConn] = useState("idle");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<"mission" | "compare">("mission");
  const timers = useRef<number[]>([]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  const push = useCallback((e: MissionEvent) => setEvents((xs) => (xs.some((x) => x.id === e.id) ? xs : [...xs, e])), []);
  const stopReplay = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const start = async () => {
    setErr(""); setEvents([]); stopReplay();
    if (mode === "replay") {
      const id = `sim_${repo}`; setMissionId(id);
      const script = assertValid(repo === "titles" ? titlesScript(id, Date.now()) : stockScript(id, Date.now()));
      const instant = params.get("instant") === "1";
      script.forEach((e, i) => { timers.current.push(window.setTimeout(() => push(e), instant ? 0 : i * 450)); });
      return;
    }
    try { setBusy(true); setMissionId(await createMission(repo, request)); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (DEV && params.get("replay")) start(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (mode !== "live" || !missionId) return; return subscribe(missionId, push, setConn); }, [mode, missionId, push]);

  const v = useMemo(() => derive(events), [events]);
  const decide = async (ok: boolean) => {
    if (!missionId) return; setErr("");
    if (mode === "replay") { const last = v.events[v.events.length - 1]; assertValid(decisionEvents(missionId, last.id, v.pendingApproval!.code_rev!, ok)).forEach(push); return; }
    try { setBusy(true); await approve(missionId, ok); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const fetchArtifact = useCallback(async (a: string) => {
    const r = await fetch(`/missions/${encodeURIComponent(missionId ?? "")}/artifacts/${encodeURIComponent(a)}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(String(r.status)); return r.text();
  }, [missionId]);

  return (
    <>
    <Background />
    <div className="app">
      <nav className="top">
        <span className="brand"><span className="mon" aria-hidden="true">D</span>DevPilot</span>
        <button className={tab === "mission" ? "tab on" : "tab"} onClick={() => setTab("mission")}>Mission</button>
        <button className={tab === "compare" ? "tab on" : "tab"} onClick={() => setTab("compare")}>Compare</button>
        <span className="grow" />
        {DEV && <label className={`replay ${mode === "replay" ? "on" : ""}`}><input type="checkbox" checked={mode === "replay"} onChange={(e) => { stopReplay(); setEvents([]); setMissionId(null); setMode(e.target.checked ? "replay" : "live"); }} /> Demo replay (simulated)</label>}
      </nav>
      {mode === "replay" && <div className="simbar">Demo replay (simulated): events below are scripted for UI demonstration, not from a real run.</div>}
      {tab === "compare" ? <Comparison disabled={mode === "replay"} /> : (
        <>
          <section className="card launch">
            <div className="repos">{REPOS.map((r) => <button key={r} className={r === repo ? "chip on" : "chip"} onClick={() => { setRepo(r); setRequest(REQUESTS[r]); }}>{r}</button>)}</div>
            <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={2} readOnly={mode === "replay"} />
            <button className="primary" disabled={busy || !request.trim() || (mode === "replay" && repo !== "stock" && repo !== "titles")} onClick={start}>{mode === "replay" ? "Play replay" : "Launch mission"}</button>
            {mode === "replay" && repo !== "stock" && repo !== "titles" && <span className="muted small">Replay scripts exist for stock and titles.</span>}
            {err && <p className="fail">{err}</p>}
          </section>
          {missionId && (
            <>
              <Dojo v={v} now={now} />
              <Header v={v} mode={mode} conn={conn} now={now} />
              <Escalation v={v} />
              <div className="grid">
                <div className="colL"><TaskBoard v={v} /><Evidence v={v} /><Approval v={v} onDecide={decide} busy={busy} error="" /><DiffViewer v={v} fetchArtifact={mode === "live" ? fetchArtifact : undefined} /></div>
                <div className="colR"><Timeline v={v} /></div>
              </div>
            </>
          )}
        </>
      )}
    </div>
    </>
  );
}
