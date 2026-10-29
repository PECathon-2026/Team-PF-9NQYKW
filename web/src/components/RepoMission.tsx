import { useState } from "react";
import { ArrowRight, Download, GitBranch, Loader2 } from "lucide-react";
import { checkRef, checkRepoUrl, createGithubMission, GithubMissionError, type GithubField } from "../lib/github";
import type { MissionEvent } from "../lib/types";
import "./repo-mission.css";

/** New-mission form for a public GitHub repository: link, optional branch/tag, request. */
export function RepoMissionForm({ disabled, onLaunched }: { disabled?: boolean; onLaunched: (id: string) => void }) {
  const [url, setUrl] = useState(""); const [ref, setRef] = useState(""); const [request, setRequest] = useState("");
  const [errors, setErrors] = useState<Partial<Record<GithubField, string>>>({}); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: Partial<Record<GithubField, string>> = {};
    const u = checkRepoUrl(url); if (u) next.repo_url = u;
    const r = checkRef(ref); if (r) next.ref = r;
    if (!request.trim()) next.request = "Describe the change you want DevPilot to make.";
    setErrors(next); if (Object.keys(next).length) return;
    setBusy(true);
    try { onLaunched(await createGithubMission({ repo_url: url, ref, request })); }
    catch (err) { const g = err instanceof GithubMissionError ? err : null; setErrors({ [g?.field ?? "form"]: g?.message ?? String(err) }); }
    finally { setBusy(false); }
  };
  const err = (f: GithubField) => errors[f] ? <p className="rm-error" id={`rm-${f}-error`} role="alert">{errors[f]}</p> : null;
  return <section className="card rm-card">
    <h2 className="rm-title"><GitBranch size={22} /> Work on a GitHub repository</h2>
    <p className="rm-lead">Paste a public Python repository that uses pytest. DevPilot downloads a copy, makes the change and checks it with the repository's own tests. You get a patch to download; nothing is pushed to the repository.</p>
    <form onSubmit={submit} noValidate>
      <label className="rm-label" htmlFor="rm-url">Repository link</label>
      <input id="rm-url" className={`rm-input ${errors.repo_url ? "rm-invalid" : ""}`} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repo" value={url} disabled={disabled || busy} aria-invalid={!!errors.repo_url} aria-describedby={errors.repo_url ? "rm-repo_url-error" : "rm-url-hint"} onChange={(e) => { setUrl(e.target.value); setErrors((x) => ({ ...x, repo_url: undefined, form: undefined })); }} />
      {err("repo_url") ?? <p className="rm-hint" id="rm-url-hint">Public repositories on github.com only.</p>}
      <label className="rm-label" htmlFor="rm-ref">Branch or tag <span className="rm-optional">(optional)</span></label>
      <input id="rm-ref" className={`rm-input rm-input-short ${errors.ref ? "rm-invalid" : ""}`} type="text" autoComplete="off" spellCheck={false} placeholder="Default branch" value={ref} disabled={disabled || busy} aria-invalid={!!errors.ref} aria-describedby={errors.ref ? "rm-ref-error" : undefined} onChange={(e) => { setRef(e.target.value); setErrors((x) => ({ ...x, ref: undefined, form: undefined })); }} />
      {err("ref")}
      <label className="rm-label" htmlFor="rm-request">What should change?</label>
      <textarea id="rm-request" className={`rm-input rm-textarea ${errors.request ? "rm-invalid" : ""}`} rows={4} placeholder="For example: Fix the bug where parse_date() crashes on empty strings, and add a test for it." value={request} disabled={disabled || busy} aria-invalid={!!errors.request} aria-describedby={errors.request ? "rm-request-error" : undefined} onChange={(e) => { setRequest(e.target.value); setErrors((x) => ({ ...x, request: undefined, form: undefined })); }} />
      {err("request")}
      {err("form")}
      <button type="submit" className="primary rm-submit" disabled={disabled || busy}>{busy ? <><Loader2 size={18} className="rm-spin" /> Downloading and preparing…</> : <>Start mission on this repository <ArrowRight size={18} /></>}</button>
      {busy && <p className="rm-hint">This can take up to a minute while the repository and its dependencies are fetched.</p>}
      {disabled && <p className="rm-hint">Turn off demo replay to start a mission on a real repository.</p>}
    </form>
  </section>;
}

/** Shown on a GitHub mission: where the code came from, how it is checked, and the patch download. */
export function RepoSourceBanner({ events, missionId }: { events: MissionEvent[]; missionId: string | null }) {
  const started = events.find((e) => e.type === "mission_started");
  const source = started?.payload.source as { repo_url?: string; ref?: string; commit?: string } | undefined;
  if (!missionId || !source || started?.payload.acceptance_mode !== "repo_tests") return null;
  const hasDiff = events.some((e) => e.type === "diff");
  return <section className="card rm-banner">
    <div className="rm-banner-text">
      <strong className="rm-banner-label">{String(started.payload.repo ?? "")}</strong>
      <span>Commit <code>{source.commit?.slice(0, 12)}</code> · No hidden acceptance suite: evidence is the repo's own tests.</span>
    </div>
    {hasDiff ? <a className="primary rm-download" href={`/missions/${encodeURIComponent(missionId)}/patch`} download><Download size={18} /> Download patch</a> : <span className="rm-hint">The patch is available once files change.</span>}
  </section>;
}
