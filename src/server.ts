import { Service, type Options } from "./service";
import { loadRegistry } from "./registry";
import type { Event } from "./store";
export function startServer(options: Options & { port?: number }) {
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
              "SELECT content FROM artifacts WHERE mission_id=? AND id=? AND kind='diff'",
            )
            .get(artifactMatch[1]!, artifactMatch[2]!);
          if (!artifact)
            return Response.json({ error: "NOT_FOUND" }, { status: 404 });
          return new Response(artifact.content, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'",
              "cache-control": "no-store",
            },
          });
        }
        const match = url.pathname.match(
          /^\/missions\/([^/]+)(?:\/(approve))?$/,
        );
        if (req.method === "GET" && match && !match[2]) {
          const m = service.store.get(match[1]!);
          if (!m) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
          const events = service.store.events(m.id);
          const { suite, snapshot, base_ref, ...publicMission } = m;
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
            usage: service.store.usage(m.id),
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
      process.env.DEVPILOT_FIXTURES_DIR || "../devpilot-fixtures",
    );
  } catch {
    throw Error("Unable to read repository registry");
  }
  startServer({
    root: process.env.DEVPILOT_RUNTIME || "runtime",
    registry,
    mock: process.env.DEVPILOT_MODEL === "mock",
  });
  console.log("DevPilot listening on http://127.0.0.1:8787");
}
