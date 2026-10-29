// POST /missions with a public GitHub repository (see README "Missions on your own GitHub repository").
export interface GithubMissionInput { repo_url: string; ref?: string; request: string }
export type GithubField = "repo_url" | "ref" | "request" | "form";
/** Thrown with the field the message belongs to, so it can be shown inline. */
export class GithubMissionError extends Error {
  constructor(public code: string, message: string, public field: GithubField) { super(message); }
}
const FIELD: Record<string, GithubField> = {
  INVALID_REPO_URL: "repo_url", CLONE_FAILED: "repo_url", CLONE_TOO_LARGE: "repo_url", CLONE_TIMEOUT: "repo_url",
  UNSUPPORTED_PROJECT: "repo_url", DEPENDENCY_INSTALL_FAILED: "repo_url", INVALID_REF: "ref", MISSING_REQUEST: "request",
};
/** Same rule as the server: https://github.com/<owner>/<repo>. Returns a message, or "" when it looks fine. */
export function checkRepoUrl(value: string): string {
  const v = value.trim();
  if (!v) return "Paste the link to a public GitHub repository.";
  if (!/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*?(\.git)?\/?$/.test(v))
    return "Use a link like https://github.com/owner/repo (https and github.com only, no extra path).";
  return "";
}
export function checkRef(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(v) || v.startsWith("-") || v.includes("..") || v.startsWith("/") || v.endsWith("/"))
    return "Use a branch or tag name like main or v1.2.0, or leave this empty.";
  return "";
}
export async function createGithubMission(input: GithubMissionInput): Promise<string> {
  const body: Record<string, string> = { repo_url: input.repo_url.trim(), request: input.request };
  if (input.ref?.trim()) body.ref = input.ref.trim();
  let r: Response;
  try {
    r = await fetch("/missions", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  } catch { throw new GithubMissionError("NETWORK", "Could not reach DevPilot. Check your connection and try again.", "form"); }
  const text = await r.text();
  let j: { error?: unknown; message?: unknown; mission_id?: unknown; id?: unknown } | null = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const code = typeof j?.error === "string" ? j.error : `HTTP_${r.status}`;
    const message = typeof j?.message === "string" && j.message ? j.message : `The mission could not start (${code}).`;
    throw new GithubMissionError(code, message, FIELD[code] ?? "form");
  }
  const id = j?.mission_id ?? j?.id;
  if (typeof id !== "string") throw new GithubMissionError("BAD_RESPONSE", "The server did not return a mission ID.", "form");
  return id;
}
