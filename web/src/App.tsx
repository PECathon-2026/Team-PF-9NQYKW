import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, Check, ChevronRight, CirclePlay, Columns2, Command, FileDiff, GitBranch, LayoutDashboard, ListChecks, PanelLeftClose, PanelLeftOpen, Plus, Search, ShieldCheck, X } from "lucide-react";
import { approve, createMission, fetchRequests, subscribe } from "./lib/api";
import { col, derive, isResolved, short } from "./lib/derive";
import { assertValid, decisionEvents, stockScript, titlesScript } from "./lib/replay";
import { LOCAL_CATALOG, REQUESTS, type RequestCatalog } from "./lib/requests";
import { errorText, eventLabel } from "./lib/labels";
import { REPOS, type MissionEvent, type RepoId } from "./lib/types";
import { Approval, DiffViewer, Escalation, Evidence, Header, TaskBoard, Timeline, WhyApprove } from "./components/Panels";
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
  // Registered requests for the launch dropdown, from the service's GET /requests
  // (falls back to the local list in lib/requests.ts if the service is unreachable).
  const [catalog, setCatalog] = useState<RequestCatalog>(LOCAL_CATALOG);
  useEffect(() => { const ac = new AbortController(); fetchRequests(ac.signal).then((r) => setCatalog(r.catalog), () => {}); return () => ac.abort(); }, []);
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
    try { setBusy(true); setMissionId(await createMission(repo, request)); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (params.get("replay") === "1") start(); }, []);
  useEffect(() => { if (mode !== "live" || !missionId) return; return subscribe(missionId, push, setConn); }, [mode, missionId, push]);
  const v = useMemo(() => derive(events), [events]);
  const decide = async (ok: boolean) => {
    if (!missionId || !v.pendingApproval) return; setErr("");
    if (mode === "replay") { const last = v.events[v.events.length - 1]; assertValid(decisionEvents(missionId, last.id, v.pendingApproval.code_rev!, ok)).forEach(push); return; }
    try { setBusy(true); await approve(missionId, ok); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const fetchArtifact = useCallback(async (a: string) => {
    const r = await fetch(`/missions/${encodeURIComponent(missionId ?? "")}/artifacts/${encodeURIComponent(a)}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(String(r.status)); return r.text();
  }, [missionId]);
  const newMission = () => { stopReplay(); setMissionId(null); setEvents([]); setErr(""); setFilter("all"); navigate("mission"); };
  const chooseRepo = (r: RepoId) => { if (r !== repo) newMission(); setRepo(r); setRequest(catalog[r][0] ?? REQUESTS[r]); navigate("mission"); };
  const registered = catalog[repo]; const custom = !registered.includes(request);
  const chooseAgent = (id: FigureAgent) => { setFilter((current) => current === id ? "all" : id); setTab("activity"); navigate("mission"); };
  const toggleReplay = () => { stopReplay(); setEvents([]); setMissionId(null); setMode((m) => m === "live" ? "replay" : "live"); navigate("mission"); };
  const commands = [
    ...TABS.map((t) => ({ group: "Go to", label: t.label, icon: t.icon, run: () => { navigate("mission"); setTab(t.id); } })),
    { group: "Go to", label: "Compare runs", icon: Columns2, run: () => navigate("compare") },
    { group: "Actions", label: "New mission", icon: Plus, run: newMission },
    ...CAST.map((a) => ({ group: "Agents", label: a.name, icon: Activity, run: () => { setFilter(a.id); setTab("activity"); navigate("mission"); } })),
    ...REPOS.map((r) => ({ group: "Repositories", label: r, icon: GitBranch, run: () => chooseRepo(r) })),
    { group: "Actions", label: mode === "live" ? "Start demo replay" : "Exit demo replay", icon: CirclePlay, run: toggleReplay },
  ].filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(query.toLowerCase()));
  const pending = !!v.pendingApproval && !v.approvalResult && !v.done;
  return <><Background /><div className={`shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <aside className="sidebar">
      <div className="brand-row"><button className="brand-mark" onClick={() => navigate("mission")} aria-label="DevPilot home">D</button><span className="brand-name">DevPilot</span><button className="icon-button collapse" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
      <div className="side-nav">
        <button className={route === "mission" ? "side-link active" : "side-link"} onClick={() => navigate("mission")} title="Missions"><LayoutDashboard size={17} /><span>Missions</span></button>
        <button className={route === "compare" ? "side-link active" : "side-link"} onClick={() => navigate("compare")} title="Compare"><Columns2 size={17} /><span>Compare</span></button>
        <button className={mode === "replay" ? "side-link replay-active" : "side-link"} onClick={toggleReplay} title={mode === "replay" ? "Exit demo replay" : "Start demo replay"} aria-pressed={mode === "replay"}><CirclePlay size={17} /><span>Demo replay</span>{mode === "replay" && <small>On</small>}</button>
      </div>
      <div className="side-section"><div className="side-heading">Repositories</div>{REPOS.map((r) => <button className={`repo-link ${repo === r ? "active" : ""}`} key={r} onClick={() => chooseRepo(r)} title={r}><GitBranch size={14} /><span>{r}</span></button>)}</div>
    </aside>
    <main className="main">
      <div className="utility-bar"><div className="breadcrumb">{route === "compare" ? <strong>Compare</strong> : <><span>{repo}</span><ChevronRight size={13} /><strong>{missionId ? "Mission" : "New mission"}</strong></>}</div><div className="utility-actions"><button className="new-mission-button" onClick={newMission}><Plus size={14} /> New mission</button><button className="search-shortcut" onClick={() => { setPalette(true); setQuery(""); }}><Search size={14} /><span>Commands</span><kbd>⌘K</kbd></button></div></div>
      {mode === "replay" && <div className="simbar"><CirclePlay size={14} /><span><strong>Demo replay (simulated)</strong> Events are scripted, not from a real run.</span></div>}
      {route === "compare" ? <div className="content compare-page view-enter"><div className="page-heading"><h1>Compare runs</h1><p>A recorded multi-agent mission beside its single-agent baseline.</p></div><Comparison disabled={mode === "replay"} /></div> : <>
        {missionId && <div className="mission-top"><Header v={v} mode={mode} conn={conn} now={now} /></div>}
        {!missionId ? <div className="content launch-page view-enter"><section className="card launch"><h2 className="launch-heading">New mission</h2><label className="field-label" htmlFor="repo-select">Repository</label><select id="repo-select" value={repo} onChange={(e) => chooseRepo(e.target.value as RepoId)}>{REPOS.map((r) => <option key={r}>{r}</option>)}</select><label className="field-label" htmlFor="request-select">Registered request</label><select id="request-select" value={custom ? "" : request} disabled={mode === "replay"} onChange={(e) => setRequest(e.target.value)}>{custom && <option value="" disabled>Custom request</option>}{registered.map((r) => <option key={r} value={r} title={r}>{r.length > 90 ? `${r.slice(0, 89)}…` : r}</option>)}</select><label className="field-label" htmlFor="mission-request">Request</label><textarea id="mission-request" value={request} onChange={(e) => setRequest(e.target.value)} rows={4} readOnly={mode === "replay"} /><div className="launch-actions"><button className="primary" disabled={busy || !request.trim() || (mode === "replay" && repo !== "stock" && repo !== "titles")} onClick={start}>{mode === "replay" ? "Start replay" : "Launch mission"} <ArrowRight size={15} /></button></div>{mode === "replay" && repo !== "stock" && repo !== "titles" && <p className="muted small launch-note">Demo replay is available for stock and titles.</p>}{err && <p className="fail">{err}</p>}</section></div> : <>
          <Dojo v={v} now={now} selected={filter} onSelect={chooseAgent} />
          <div className="tab-bar" role="tablist" aria-label="Mission sections">{TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "section-tab active" : "section-tab"} onClick={() => setTab(t.id)}><t.icon size={15} />{t.label}{t.id === "activity" && <span className="tab-count">{v.events.length}</span>}</button>)}</div>
          <div className={`content tab-content ${pending ? "has-approval" : ""}`}><Escalation v={v} />{err && <p className="fail error-banner">{err}</p>}
            <div className="tab-panel" key={tab} role="tabpanel">
              {tab === "overview" && <><div className="overview-summary"><div><span>Tasks done</span><strong>{v.tasks.filter((t) => col(t.status) === "done").length} / {v.tasks.length}</strong></div><div><span>Checks passed</span><strong>{v.checks.filter((c) => c.outcome === "passed" && !c.stale).length} / {v.checks.length}</strong></div><div><span>Findings</span><strong>{v.findings.length} total · {v.findings.filter((f) => !isResolved(f.action)).length} open</strong></div><div><span>Latest event</span><strong>{v.events.length ? eventLabel(v.events[v.events.length - 1].type) : "—"}</strong></div></div><TaskBoard v={v} /></>}
              {tab === "evidence" && <Evidence v={v} />}{tab === "diff" && <DiffViewer v={v} fetchArtifact={mode === "live" ? fetchArtifact : undefined} />}{tab === "activity" && <Timeline v={v} filter={filter} setFilter={setFilter} />}{tab === "approval" && <>{v.pendingApproval || v.approvalResult ? <><Approval v={v} onDecide={decide} busy={busy} error="" /><WhyApprove v={v} fetchArtifact={mode === "live" ? fetchArtifact : undefined} /></> : <section className="card"><h3>Approval</h3><p className="muted">No approval requested yet.</p></section>}{v.pendingApproval && <Evidence v={v} />}</>}
            </div>
          </div>
          {pending && <div className="approval-bar"><div className="approval-symbol"><ShieldCheck size={18} /></div><div className="approval-copy"><strong>{v.gate.ok ? "Ready for your approval" : "Approval requested"} <span title={v.pendingApproval?.code_rev ?? undefined}>{short(v.pendingApproval?.code_rev)}</span></strong>{!v.gate.ok && <small>{v.gate.reasons.join(" · ")}</small>}</div><button onClick={() => setTab("approval")}>Review</button><button disabled={busy} onClick={() => decide(false)}>Reject</button><button className="primary" disabled={!v.gate.ok || busy} title={!v.gate.ok ? v.gate.reasons.join(" · ") : ""} onClick={() => decide(true)}><Check size={15} /> Approve</button></div>}
        </>}
      </>}
    </main>
    {palette && <div className="palette-backdrop" onMouseDown={() => setPalette(false)}><div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}><div className="palette-input"><Search size={18} /><input autoFocus aria-label="Search commands" placeholder="Search commands, agents and repositories" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && commands[0]) { commands[0].run(); setPalette(false); } }} /><button className="icon-button" aria-label="Close command palette" onClick={() => setPalette(false)}><X size={17} /></button></div><div className="palette-results">{commands.map((c) => <button key={`${c.group}-${c.label}`} onClick={() => { c.run(); setPalette(false); }}><c.icon size={16} /><span>{c.label}</span><small>{c.group}</small><ChevronRight size={14} /></button>)}{!commands.length && <p className="muted">No matching commands.</p>}</div><div className="palette-footer"><span><Command size={12} />K to toggle</span><span><kbd>Enter</kbd> to run · <kbd>Esc</kbd> to close</span></div></div></div>}
  </div></>;
}
