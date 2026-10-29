import { isEvent, type MissionEvent } from "./types";
// POST /missions -> 202 {"id","state"} (doc). Accept legacy {mission_id} too.
export async function createMission(repo: string, request: string): Promise<string> {
  const r = await fetch("/missions", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ repo, request }) });
  if (!r.ok) throw new Error(`Could not launch the mission (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json(); const id = j.mission_id ?? j.id;
  if (typeof id !== "string") throw new Error("The server did not return a mission ID.");
  return id;
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
  let last: number | null = null; let closed = false; let ws: WebSocket | null = null; const seen = new Set<number>();
  const connect = () => {
    ws = new WebSocket(wsUrl(id, last)); onStatus("connecting");
    ws.onopen = () => onStatus("live");
    ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (isEvent(e) && e.mission_id === id && !seen.has(e.id)) { seen.add(e.id); last = Math.max(last ?? 0, e.id); onEvent(e); } } catch { /* drop malformed */ } };
    ws.onclose = () => { if (!closed) { onStatus("reconnecting"); setTimeout(connect, 1500); } };
  };
  connect();
  return () => { closed = true; ws?.close(); };
}
