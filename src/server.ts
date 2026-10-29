import { REPO_TESTS_GATE_NOTE, Service, type Options } from "./service";
import { GithubMissionError } from "./github";
import { loadRegistry } from "./registry";
import type { Event } from "./store";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { confined } from "./tree";
export function startServer(
  options: Options & { port?: number; webDir?: string },
) {
  const service = new Service(options);
  const allowedOrigins = new Set(
    (
      process.env.DEVPILOT_ALLOWED_ORIGINS ??
      "http://localhost:5173,http://127.0.0.1:5173"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const sockets = new Map<any, { mission: string; after: number }>();
  const listener = (event: Event) => {
    for (const [ws, sub] of sockets)
      if (sub.mission === event.mission_id && event.id > sub.after) {
        ws.send(JSON.stringify(event));
        sub.after = event.id;
      }
  };
  service.store.listeners.add(listener);
  const server = Bun.serve<{ mission: string; after: number }>({
    hostname: "127.0.0.1",
    port: options.port ?? 8787,
    async fetch(req, server) {
      const url = new URL(req.url);
      const host = req.headers.get("host") || "";
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
        return new Response("Forbidden", { status: 403 });
      const origin = req.headers.get("origin");
      if (origin) {
        try {
          const o = new URL(origin);
          if (
            o.origin !== origin ||
            (origin !== `${url.protocol}//${host}` &&
              !allowedOrigins.has(origin))
          )
            return new Response("Forbidden", { status: 403 });
        } catch {
          return new Response("Forbidden", { status: 403 });
        }
      }
      if (req.method === "OPTIONS") {
        const method = req.headers.get("access-control-request-method");
        if (!origin || !["GET", "POST"].includes(method || ""))
          return new Response("Forbidden", { status: 403 });
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type",
            vary: "Origin",
          },
        });
      }
      const response = await (async () => {
        if (url.pathname === "/ws") {
          const mission = url.searchParams.get("mission") || "",
            after = Number(url.searchParams.get("after") || 0);
          if (!service.store.get(mission))
            return new Response("Not found", { status: 404 });
          if (!Number.isSafeInteger(after) || after < 0)
            return new Response("Bad after", { status: 400 });
          if (server.upgrade(req, { data: { mission, after } })) return;
          return new Response("Upgrade required", { status: 400 });
        }
        const artifactMatch = url.pathname.match(
          /^\/missions\/([^/]+)\/artifacts\/([^/]+)$/,
        );
        if (req.method === "GET" && artifactMatch) {
          const artifact: any = service.store.db
            .query(
              "SELECT kind, content FROM artifacts WHERE mission_id=? AND id=? AND kind IN ('diff','debug')",
            )
            .get(artifactMatch[1]!, artifactMatch[2]!);
          if (!artifact)
            return Response.json({ error: "NOT_FOUND" }, { status: 404 });
          let content = artifact.content;
          if (artifact.kind === "debug") {
            if (
              !/^m_[A-Za-z0-9_-]{1,100}$/.test(artifactMatch[1]!) ||
              !/^debug_[A-Za-z0-9_-]{1,100}$/.test(artifactMatch[2]!)
            )
              return Response.json({ error: "NOT_FOUND" }, { status: 404 });
            try {
              content = readFileSync(
                confined(
                  join(service.root, "artifacts", artifactMatch[1]!),
                  `${artifactMatch[2]}.txt`,
                ),
                "utf8",
              );
            } catch {
              return Response.json({ error: "NOT_FOUND" }, { status: 404 });
            }
          }
          return new Response(content, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'",
              "cache-control": "no-store",
            },
          });
        }
        const patchMatch = url.pathname.match(/^\/missions\/([^/]+)\/patch$/);
        if (req.method === "GET" && patchMatch) {
          // Output of a mission is a patch to download; DevPilot never pushes.
          const m = service.store.get(patchMatch[1]!);
          if (!m) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
          const latest: any = service.store.db
            .query(
              "SELECT content FROM artifacts WHERE mission_id=? AND kind='diff' ORDER BY rowid DESC LIMIT 1",
            )
            .get(m.id);
          if (!latest)
            return Response.json(
              { error: "NO_PATCH", message: "This mission has not changed any files yet." },
              { status: 404 },
            );
          const name = String(m.repo)
            .replace(/^github:/, "")
            .replace(/[^A-Za-z0-9._-]+/g, "-")
            .slice(0, 80);
          return new Response(latest.content, {
            headers: {
              "content-type": "text/x-diff; charset=utf-8",
              "content-disposition": `attachment; filename="devpilot-${name}-${m.id}.patch"`,
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'",
              "cache-control": "no-store",
            },
          });
        }
        if (req.method === "GET" && url.pathname === "/requests") {
          return Response.json({ requests: listRequests(service.registry) });
        }
        const match = url.pathname.match(
          /^\/missions\/([^/]+)(?:\/(approve))?$/,
        );
        if (req.method === "GET" && match && !match[2]) {
          const m = service.store.get(match[1]!);
          if (!m) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
          const events = service.store.events(m.id);
          const { suite, snapshot, base_ref, source, ...publicMission } = m;
          const approval = m.approval ? JSON.parse(m.approval) : null;
          return Response.json({
            ...publicMission,
            approval: approval
              ? {
                  approval_id: approval.id,
                  evidence_ids: approval.evidence_ids,
                  tree_hash: approval.candidate_hash,
                  decision: m.decision === null ? null : !!m.decision,
                  revision: approval.revision,
                  base_hash: approval.base_hash,
                }
              : null,
            evidence: JSON.parse(m.evidence),
            acceptance_mode: m.acceptance_mode || "hidden",
            source: source ? JSON.parse(source) : null,
            gate_note:
              m.acceptance_mode === "repo_tests" ? REPO_TESTS_GATE_NOTE : null,
            patch_url: `/missions/${m.id}/patch`,
            usage: service.store.usage(m.id),
            deadline_paused: m.state === "AWAITING_APPROVAL",
            deadline_remaining_ms: service.deadlineRemainingAtGate(m.id),
            watermark: events.at(-1)?.id || 0,
          });
        }
        if (
          req.method === "POST" &&
          (url.pathname === "/missions" || match?.[2] === "approve")
        ) {
          if (
            !req.headers
              .get("content-type")
              ?.toLowerCase()
              .startsWith("application/json")
          )
            return Response.json({ error: "JSON_REQUIRED" }, { status: 415 });
          let body: any;
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "INVALID_JSON" }, { status: 400 });
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
          if (url.pathname === "/missions" && "repo_url" in body) {
            const extra = Object.keys(body).find(
              (k) => !["repo_url", "ref", "request", "mode"].includes(k),
            );
            if (extra)
              return Response.json(
                {
                  error: "INVALID_REQUEST",
                  message: `Unexpected field "${extra.slice(0, 40)}". Send repo_url, request and optionally ref and mode.`,
                },
                { status: 400 },
              );
            try {
              const mid = await service.createGithub(body);
              const m = service.store.get(mid);
              return Response.json(
                {
                  mission_id: mid,
                  id: mid,
                  label: m.repo,
                  acceptance_mode: m.acceptance_mode,
                },
                { status: 202 },
              );
            } catch (error: any) {
              if (error instanceof GithubMissionError)
                return Response.json(
                  { error: error.code, message: error.message },
                  { status: error.status },
                );
              return Response.json(
                {
                  error: "CLONE_FAILED",
                  message:
                    "The repository was downloaded but could not be prepared as a mission.",
                },
                { status: 500 },
              );
            }
          }
          if (url.pathname === "/missions") {
            if (
              typeof body.repo !== "string" ||
              !body.repo ||
              typeof body.request !== "string" ||
              !body.request.trim() ||
              body.request.length > 10000 ||
              Object.keys(body).some(
                (k) =>
                  !["repo", "request", "mode", "paired_mission_id"].includes(k),
              ) ||
              (body.mode !== undefined &&
                !["multi", "baseline"].includes(body.mode)) ||
              (body.paired_mission_id !== undefined &&
                (typeof body.paired_mission_id !== "string" ||
                  !body.paired_mission_id ||
                  body.mode !== "baseline"))
            )
              return Response.json(
                { error: "INVALID_REQUEST" },
                { status: 400 },
              );
            if (!Object.hasOwn(service.registry, body.repo))
              return Response.json({ error: "UNKNOWN_REPO" }, { status: 404 });
            const registered = service.registry[body.repo].requests;
            if (registered && !Object.hasOwn(registered, body.request))
              return Response.json(
                {
                  error: "UNKNOWN_REQUEST",
                  message:
                    "Request text must exactly match a registered request for this repo.",
                  repo: body.repo,
                  valid_requests: Object.keys(registered),
                },
                { status: 400 },
              );
            try {
              const mid = service.create(
                body.repo,
                body.request,
                body.mode,
                body.paired_mission_id,
              );
              return Response.json(
                { mission_id: mid, id: mid },
                { status: 202 },
              );
            } catch (error: any) {
              return Response.json(
                {
                  error:
                    error.message === "INVALID_PAIR"
                      ? "INVALID_PAIR"
                      : "SNAPSHOT_UNAVAILABLE",
                },
                { status: 409 },
              );
            }
          }
          if (
            typeof body.approved !== "boolean" ||
            Object.keys(body).some((k) => k !== "approved")
          )
            return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
          try {
            service.approve(match![1]!, body.approved);
            return Response.json({ accepted: true }, { status: 202 });
          } catch (e: any) {
            return Response.json(
              {
                error:
                  e.message === "NOT_FOUND" ? "NOT_FOUND" : "APPROVAL_CONFLICT",
              },
              { status: e.message === "NOT_FOUND" ? 404 : 409 },
            );
          }
        }
        if (options.webDir && (req.method === "GET" || req.method === "HEAD"))
          return serveStatic(options.webDir, url.pathname);
        return new Response("Not found", { status: 404 });
      })();
      if (response && origin) {
        response.headers.set("access-control-allow-origin", origin);
        response.headers.append("vary", "Origin");
      }
      return response;
    },
    websocket: {
      open(ws) {
        sockets.set(ws, ws.data);
        for (const event of service.store.events(
          ws.data.mission,
          ws.data.after,
        )) {
          if (event.id > ws.data.after) {
            ws.send(JSON.stringify(event));
            ws.data.after = event.id;
          }
        }
      },
      message() {},
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    server,
    service,
    close() {
      service.store.listeners.delete(listener);
      server.stop(true);
      service.close();
    },
  };
}
if (import.meta.main) {
  let registry: Record<string, any>;
  try {
    registry = loadRegistry(
      process.env.DEVPILOT_REGISTRY || "config/repositories.json",
      process.env.DEVPILOT_FIXTURES_DIR || resolve(import.meta.dir, ".."),
    );
  } catch {
    throw Error("Unable to read repository registry");
  }
  startServer({
    root: process.env.DEVPILOT_RUNTIME || "runtime",
    registry,
    mock: process.env.DEVPILOT_MODEL === "mock",
    port: Number(process.env.PORT || 8787),
    webDir: process.env.DEVPILOT_WEB_DIR || undefined,
  });
  console.log(
    `DevPilot listening on http://127.0.0.1:${process.env.PORT || 8787}`,
  );
}

/** Public list of registered requests for UI dropdowns (no suite paths or digests). */
export function listRequests(registry: Record<string, any>) {
  const out: Array<{
    repo: string;
    request: string;
    label: string;
    has_acceptance: boolean;
  }> = [];
  for (const [repo, cfg] of Object.entries(registry)) {
    for (const [request, entry] of Object.entries<any>(cfg?.requests || {})) {
      out.push({
        repo,
        request,
        label: cfg.label || repo,
        has_acceptance: !!entry?.suite,
      });
    }
  }
  return out;
}

/** Serve a built single-page app; unknown non-asset paths fall back to index.html. */
async function serveStatic(webDir: string, pathname: string) {
  const root = resolve(webDir);
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  let file = resolve(root, rel);
  if (file !== root && !file.startsWith(root + "/"))
    return new Response("Not found", { status: 404 });
  let f = Bun.file(file);
  if (!(await f.exists()) || rel.endsWith("/")) {
    if (/\.[a-z0-9]+$/i.test(rel)) return new Response("Not found", { status: 404 });
    f = Bun.file(join(root, "index.html"));
    if (!(await f.exists())) return new Response("Not found", { status: 404 });
  }
  return new Response(f);
}
