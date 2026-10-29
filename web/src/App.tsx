import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, Check, ChevronRight, CirclePlay, Columns2, Command, FileDiff, GitBranch, LayoutDashboard, ListChecks, PanelLeftClose, PanelLeftOpen, Plus, Search, ShieldCheck, X } from "lucide-react";
import { approve, createMission, subscribe } from "./lib/api";
import { derive, short } from "./lib/derive";
import { assertValid, decisionEvents, stockScript, titlesScript } from "./lib/replay";
import { REQUESTS } from "./lib/requests";
import { REPOS, type MissionEvent, type RepoId } from "./lib/types";
import { Approval, DiffViewer, Escalation, Evidence, Header, TaskBoard, Timeline } from "./components/Panels";
import { Comparison } from "./components/Comparison";
import { CAST, Dojo, type FigureAgent } from "./components/Dojo";
import { Background } from "./components/Background";

type Mode = "live" | "replay";
type Tab = "overview" | "evidence" | "diff" | "activity" | "approval";
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard }, { id: "evidence", label: "Evidence", icon: ListChecks },
  { id: "diff", label: "Diff", icon: FileDiff }, { id: "activity", label: "Activity", icon: Activity },
  { id: "approval", label: "Approval", icon: ShieldCheck },
] as const;

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [mode, setMode] = useState<Mode>(params.get("replay") === "1" ? "replay" : "live");
  const initialRepo = params.get("repo");
  const [repo, setRepo] = useState<RepoId>(REPOS.includes(initialRepo as RepoId) ? initialRepo as RepoId : "stock");
  const [request, setRequest] = useState(() => REQUESTS[REPOS.includes(initialRepo as RepoId) ? initialRepo as RepoId : "stock"]);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [conn, setConn] = useState("idle");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [route, setRoute] = useState(location.hash === "#/compare" ? "compare" : "mission");
  const [tab, setTab] = useState<Tab>("overview"); const [filter, setFilter] = useState("all");
  const [collapsed, setCollapsed] = useState(false); const [palette, setPalette] = useState(false); const [query, setQuery] = useState("");
  const timers = useRef<number[]>([]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  useEffect(() => { const change = () => setRoute(location.hash === "#/compare" ? "compare" : "mission"); window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((x) => !x); setQuery(""); } if (e.key === "Escape") setPalette(false); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, []);
  const navigate = (next: "mission" | "compare") => { location.hash = next === "compare" ? "/compare" : "/"; setRoute(next); };
  const push = useCallback((e: MissionEvent) => setEvents((xs) => (xs.some((x) => x.id === e.id) ? xs : [...xs, e])), []);
  const stopReplay = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => () => stopReplay(), []);
  const start = async () => {
    setErr(""); setEvents([]); setFilter("all"); setTab("overview"); stopReplay(); navigate("mission");
    if (mode === "replay") {
      const id = `sim_${repo}`; setMissionId(id);
      const script = assertValid(repo === "titles" ? titlesScript(id, Date.now()) : stockScript(id, Date.now()));
      const instant = params.get("instant") === "1";
      script.forEach((e, i) => { timers.current.push(window.setTimeout(() => push(e), instant ? 0 : i * 450)); });
      return;
    }
    try { setBusy(true); setMissionId(await createMission(repo, request)); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (params.get("replay") === "1") start(); }, []);
  useEffect(() => { if (mode !== "live" || !missionId) return; return subscribe(missionId, push, setConn); }, [mode, missionId, push]);
  const v = useMemo(() => derive(events), [events]);
  const decide = async (ok: boolean) => {
    if (!missionId || !v.pendingApproval) return; setErr("");
    if (mode === "replay") { const last = v.events[v.events.length - 1]; assertValid(decisionEvents(missionId, last.id, v.pendingApproval.code_rev!, ok)).forEach(push); return; }
    try { setBusy(true); await approve(missionId, ok); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const fetchArtifact = useCallback(async (a: string) => {
    const r = await fetch(`/missions/${encodeURIComponent(missionId ?? "")}/artifacts/${encodeURIComponent(a)}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(String(r.status)); return r.text();
  }, [missionId]);
  const newMission = () => { stopReplay(); setMissionId(null); setEvents([]); setErr(""); setFilter("all"); navigate("mission"); };
  const chooseRepo = (r: RepoId) => { if (r !== repo) newMission(); setRepo(r); setRequest(REQUESTS[r]); navigate("mission"); };
  const chooseAgent = (id: FigureAgent) => { setFilter((current) => current === id ? "all" : id); setTab("activity"); navigate("mission"); };
  const toggleReplay = () => { stopReplay(); setEvents([]); setMissionId(null); setMode((m) => m === "live" ? "replay" : "live"); navigate("mission"); };
  const commands = [
    ...TABS.map((t) => ({ group: "Navigate", label: t.label, icon: t.icon, run: () => { navigate("mission"); setTab(t.id); } })),
    { group: "Navigate", label: "Compare runs", icon: Columns2, run: () => navigate("compare") },
    { group: "Actions", label: "New mission", icon: Plus, run: newMission },
    ...CAST.map((a) => ({ group: "Agents", label: a.name, icon: Activity, run: () => { setFilter(a.id); setTab("activity"); navigate("mission"); } })),
    ...REPOS.map((r) => ({ group: "Repositories", label: r, icon: GitBranch, run: () => chooseRepo(r) })),
    { group: "Actions", label: mode === "live" ? "Enable demo replay" : "Exit demo replay", icon: CirclePlay, run: toggleReplay },
  ].filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(query.toLowerCase()));
  const pending = !!v.pendingApproval && !v.approvalResult && !v.done;
  return <><Background /><div className={`shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <aside className="sidebar">
      <div className="brand-row"><button className="brand-mark" onClick={() => navigate("mission")} aria-label="DevPilot home">D</button><span className="brand-name">DevPilot <small>MISSION CONTROL</small></span><button className="icon-button collapse" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
      <div className="side-nav">
        <button className={route === "mission" ? "side-link active" : "side-link"} onClick={() => navigate("mission")} title="Missions"><LayoutDashboard size={17} /><span>Missions</span></button>
        <button className={route === "compare" ? "side-link active" : "side-link"} onClick={() => navigate("compare")} title="Compare"><Columns2 size={17} /><span>Compare</span></button>
        <button className={mode === "replay" ? "side-link replay-active" : "side-link"} onClick={toggleReplay} title="Replay"><CirclePlay size={17} /><span>Replay</span>{mode === "replay" && <small>ON</small>}</button>
      </div>
      <div className="side-section"><div className="side-heading">WORKSPACE <span>REPOSITORIES</span></div>{REPOS.map((r) => <button className={`repo-link ${repo === r ? "active" : ""}`} key={r} onClick={() => chooseRepo(r)} title={r}><GitBranch size={14} /><span>{r}</span>{repo === r && missionId && <small>{v.state === "COMPLETED" ? "COMPLETE" : v.state === "WAITING" ? "WAITING" : "ACTIVE"}</small>}</button>)}</div>
      <div className="sidebar-bottom"><button className="side-link command-trigger" onClick={() => { setPalette(true); setQuery(""); }}><Search size={16} /><span>Quick search</span><kbd>⌘ K</kbd></button><div className="workspace-label"><span className="workspace-icon">DP</span><span>DevPilot workspace<small>Agent operations</small></span></div></div>
    </aside>
    <main className="main">
      <div className="utility-bar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><span>{route === "compare" ? "Compare" : repo}</span><ChevronRight size={14} /><strong>{route === "compare" ? "Baseline" : "Mission"}</strong></div><div className="utility-actions"><button className="new-mission-button" onClick={newMission}><Plus size={14} /> New mission</button><button className="search-shortcut" onClick={() => { setPalette(true); setQuery(""); }}><Search size={14} /> Search <kbd>⌘ K</kbd></button></div></div>
      {mode === "replay" && <div className="simbar"><CirclePlay size={14} /> Demo replay (simulated): events are scripted for UI demonstration, not from a real run.</div>}
      {route === "compare" ? <div className="content compare-page"><div className="page-heading"><div><span className="eyebrow">Evaluation</span><h1>Compare runs</h1><p>Compare a recorded multi-agent mission with its single-agent baseline.</p></div></div><Comparison disabled={mode === "replay"} /></div> : <>
        <div className="mission-top">{missionId ? <Header v={v} mode={mode} conn={conn} now={now} /> : <div className="new-mission-title"><span className="eyebrow">{repo} / mission</span><h1>Start a mission</h1></div>}</div>
        {!missionId ? <div className="content launch-page"><section className="card launch"><div className="launch-heading"><div><span className="eyebrow">New mission</span><h2>What should the agents work on?</h2><p>Choose a repository and describe the change.</p></div><GitBranch size={22} /></div><label className="field-label" htmlFor="repo-select">Repository</label><select id="repo-select" value={repo} onChange={(e) => chooseRepo(e.target.value as RepoId)}>{REPOS.map((r) => <option key={r}>{r}</option>)}</select><label className="field-label" htmlFor="mission-request">Request</label><textarea id="mission-request" value={request} onChange={(e) => setRequest(e.target.value)} rows={4} readOnly={mode === "replay"} /><div className="launch-actions"><span className="muted small">{mode === "replay" ? "Scripted demonstration" : "Agents will plan, implement and verify the change."}</span><button className="primary" disabled={busy || !request.trim() || (mode === "replay" && repo !== "stock" && repo !== "titles")} onClick={start}>{mode === "replay" ? "Play replay" : "Launch mission"} <ArrowRight size={15} /></button></div>{mode === "replay" && repo !== "stock" && repo !== "titles" && <p className="muted small">Replay scripts exist for stock and titles.</p>}{err && <p className="fail">{err}</p>}</section></div> : <>
          <Dojo v={v} now={now} selected={filter} onSelect={chooseAgent} />
          <div className="tab-bar" role="tablist" aria-label="Mission sections">{TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "section-tab active" : "section-tab"} onClick={() => setTab(t.id)}><t.icon size={15} />{t.label}{t.id === "activity" && <span className="tab-count">{v.events.length}</span>}</button>)}</div>
          <div className={`content tab-content ${pending ? "has-approval" : ""}`}><Escalation v={v} />{err && <p className="fail error-banner">{err}</p>}
            {tab === "overview" && <><div className="section-intro"><div><span className="eyebrow">Mission overview</span><h2>Execution plan</h2></div><span className="muted small">{v.tasks.length} tasks · {v.checks.length} checks</span></div><div className="overview-summary"><div><span className="eyebrow">Current revision</span><strong>{short(v.currentRev)}</strong></div><div><span className="eyebrow">Checks passed</span><strong>{v.checks.filter((c) => c.outcome === "passed" && !c.stale).length} / {v.checks.length}</strong></div><div><span className="eyebrow">Findings</span><strong>{v.findings.length}</strong></div><div><span className="eyebrow">Latest activity</span><strong>{v.events.length ? v.events[v.events.length - 1].type.replace(/_/g, " ") : "Waiting"}</strong></div></div><TaskBoard v={v} /></>}
            {tab === "evidence" && <Evidence v={v} />}{tab === "diff" && <DiffViewer v={v} fetchArtifact={mode === "live" ? fetchArtifact : undefined} />}{tab === "activity" && <Timeline v={v} filter={filter} setFilter={setFilter} />}{tab === "approval" && <>{v.pendingApproval || v.approvalResult ? <Approval v={v} onDecide={decide} busy={busy} error="" /> : <section className="card"><h3>Human approval</h3><p className="muted">No approval requested yet.</p></section>}{v.pendingApproval && <Evidence v={v} />}</>}
          </div>
          {pending && <div className="approval-bar"><div className="approval-symbol"><ShieldCheck size={18} /></div><div className="approval-copy"><strong>Approval requested <span>· {short(v.pendingApproval?.code_rev)}</span></strong><small>{v.gate.ok ? "Candidate is ready for your decision" : v.gate.reasons.join(" · ")}</small></div><button onClick={() => setTab("approval")}>Review details</button><button disabled={busy} onClick={() => decide(false)}>Reject</button><button className="primary" disabled={!v.gate.ok || busy} title={!v.gate.ok ? v.gate.reasons.join(" · ") : ""} onClick={() => decide(true)}><Check size={15} /> Approve</button></div>}
        </>}
      </>}
    </main>
    {palette && <div className="palette-backdrop" onMouseDown={() => setPalette(false)}><div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}><div className="palette-input"><Search size={18} /><input autoFocus placeholder="Search commands, agents, repositories..." value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && commands[0]) { commands[0].run(); setPalette(false); } }} /><button className="icon-button" aria-label="Close" onClick={() => setPalette(false)}><X size={17} /></button></div><div className="palette-results">{commands.map((c) => <button key={`${c.group}-${c.label}`} onClick={() => { c.run(); setPalette(false); }}><c.icon size={16} /><span>{c.label}</span><small>{c.group}</small><ChevronRight size={14} /></button>)}{!commands.length && <p className="muted">No matching commands.</p>}</div><div className="palette-footer"><span><Command size={12} /> K to open</span><span>Enter to select · Esc to close</span></div></div></div>}
  </div></>;
}
