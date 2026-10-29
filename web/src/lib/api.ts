import { isEvent, type MissionEvent } from "./types";
import { LOCAL_CATALOG, normalizeRequests, type RequestCatalog } from "./requests";
// POST /missions -> 202 {"id","state"} (doc). Accept legacy {mission_id} too.
export async function createMission(repo: string, request: string): Promise<string> {
  const r = await fetch("/missions", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ repo, request }) });
  if (!r.ok) {
    const text = await r.text();
    let body: { error?: unknown; message?: unknown; repo?: unknown; valid_requests?: unknown } | null = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (body?.error === "UNKNOWN_REQUEST") {
      const valid = Array.isArray(body.valid_requests) ? body.valid_requests.filter((x): x is string => typeof x === "string") : [];
      const msg = typeof body.message === "string" && body.message ? body.message : `That request isn't registered for ${typeof body.repo === "string" ? body.repo : repo}.`;
      throw new Error(valid.length ? `${msg} Pick one of: ${valid.map((v) => `"${v}"`).join(" · ")}` : msg);
    }
    throw new Error(`Could not launch the mission (HTTP ${r.status}): ${text.slice(0, 200)}`);
  }
  const j = await r.json(); const id = j.mission_id ?? j.id;
  if (typeof id !== "string") throw new Error("The server did not return a mission ID.");
  return id;
}
/** Registered requests per repo from GET /requests ({ requests: [{ repo, request, label, has_acceptance }] }).
 *  A 404 or unusable response falls back to the local list in lib/requests.ts. */
export async function fetchRequests(signal?: AbortSignal): Promise<{ catalog: RequestCatalog; source: "service" | "local" }> {
  try {
    const r = await fetch("/requests", { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
      const catalog = normalizeRequests(await r.json());
      if (catalog) return { catalog, source: "service" };
    }
  } catch (e) { if (signal?.aborted) throw e; }
  return { catalog: LOCAL_CATALOG, source: "local" };
}
export async function approve(id: string, approved: boolean) {
  const r = await fetch(`/missions/${encodeURIComponent(id)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ approved }) });
  if (!r.ok) throw new Error(`Could not record the decision (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
}
export async function fetchEventsOnce(id: string): Promise<MissionEvent[]> {
  // Collect replay for a finished mission (used by comparison view).
  return new Promise((res) => {
    const out: MissionEvent[] = []; const ws = new WebSocket(wsUrl(id, null));
    const done = () => { ws.close(); res(out); };
    const t = setTimeout(done, 4000);
    ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (isEvent(e)) { out.push(e); if (e.type === "mission_done") { clearTimeout(t); done(); } } } catch { /* ignore */ } };
    ws.onerror = () => { clearTimeout(t); done(); };
  });
}
export function wsUrl(id: string, after: number | null) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?mission=${encodeURIComponent(id)}${after != null ? `&after=${after}` : ""}`;
}
/** Live subscription with dedupe by id and reconnect from last id. */
export function subscribe(id: string, onEvent: (e: MissionEvent) => void, onStatus: (s: string) => void) {
  let last: number | null = null; let closed = false; let ws: WebSocket | null = null; let retry: ReturnType<typeof setTimeout> | undefined; const seen = new Set<number>();
  const connect = () => {
    retry = undefined;
    if (closed) return;
    const socket = new WebSocket(wsUrl(id, last)); ws = socket; onStatus("connecting");
    socket.onopen = () => { if (!closed) onStatus("live"); };
    socket.onmessage = (m) => { if (closed) return; try { const e = JSON.parse(m.data); if (isEvent(e) && e.mission_id === id && !seen.has(e.id)) { seen.add(e.id); last = Math.max(last ?? 0, e.id); onEvent(e); } } catch { /* drop malformed */ } };
    socket.onclose = () => { if (closed || ws !== socket) return; onStatus("reconnecting"); retry = setTimeout(connect, 1500); };
  };
  connect();
  return () => {
    closed = true; clearTimeout(retry); retry = undefined;
    const socket = ws; ws = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = null; socket.close(); }
  };
}
