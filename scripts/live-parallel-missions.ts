import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer } from "../src/server";
import { loadRegistry } from "../src/registry";
import { redact } from "../src/redaction";

// Exactly one notes and one stock mission. Never approve or print model replies.
async function main() {
  let app: ReturnType<typeof startServer> | undefined;
  try {
    if (!process.env.MINIMAX_API_KEY) throw Error("MODEL_KEY_MISSING");
    const fixtureRoot = resolve(
      process.env.DEVPILOT_FIXTURES_DIR || resolve(import.meta.dir, ".."),
    );
    const registry = loadRegistry(
      process.env.DEVPILOT_REGISTRY || "config/repositories.json",
      fixtureRoot,
    );
    const runtimeParent = resolve(process.env.DEVPILOT_RUNTIME || "runtime");
    mkdirSync(runtimeParent, { recursive: true });
    const root = mkdtempSync(join(runtimeParent, "live-parallel-"));
    app = startServer({ root, registry, mock: false, port: 8797 });
    if (app.service.store.isolation !== "isolated")
      throw Error("ISOLATION_UNAVAILABLE");
    const server = app;
    const missions = await Promise.all(
      ["notes", "stock"].map(async (repo) => {
        const request = Object.keys(registry[repo].requests)[0]!;
        const response = await fetch("http://127.0.0.1:8797/missions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo, request }),
        });
        if (response.status !== 202) throw Error("MISSION_CREATE_FAILED");
        const { mission_id } = (await response.json()) as {
          mission_id: string;
        };
        return { repo, mission_id };
      }),
    );
    const reports = await Promise.all(
      missions.map(async ({ repo, mission_id }) => {
        const until = Date.now() + server.service.maxDeadlineMs + 5000;
        while (
          Date.now() < until &&
          !["AWAITING_APPROVAL", "COMPLETED", "REJECTED", "ESCALATED"].includes(
            server.service.store.get(mission_id).state,
          )
        )
          await Bun.sleep(200);
        const mission = server.service.store.get(mission_id);
        const events = server.service.store.events(mission_id);
        const terminalEvent = events.findLast(
          (event) =>
            event.type === "approval_needed" ||
            event.type === "mission_done" ||
            event.type === "escalation",
        );
        const escalation = events.findLast(
          (event) => event.type === "escalation",
        );
        const counts: Record<string, number> = {};
        for (const event of events)
          counts[event.type] = (counts[event.type] || 0) + 1;
        const findings = (blocking: boolean) =>
          events
            .filter(
              (event) =>
                event.type === "finding" &&
                event.payload.action === "open" &&
                !!event.payload.blocking === blocking,
            )
            .map((event) => ({
              agent: event.agent,
              title: redact(event.payload.title, "", 200),
            }));
        const usage = server.service.store.usage(mission_id);
        return {
          repo,
          mission_id,
          status: mission.state,
          approval_needed: events.some(
            (event) => event.type === "approval_needed",
          ),
          wall_elapsed_ms:
            terminalEvent?.payload.wall_elapsed_ms ??
            Date.now() - mission.created,
          active_elapsed_ms: terminalEvent?.payload.active_elapsed_ms ?? null,
          revisions: [
            ...new Set(
              events
                .filter((event) => event.type === "diff")
                .map((event) => String(event.code_rev).split(":")[0]),
            ),
          ],
          per_role: usage.per_agent,
          total: usage.total,
          effective_cap:
            events.findLast((event) => event.type === "usage")?.payload
              .mission_cap ?? null,
          findings: {
            blocking: findings(true),
            advisory: findings(false),
            sent_back: events.filter(
              (event) =>
                event.type === "finding" &&
                event.payload.action === "sent_back",
            ).length,
          },
          event_counts: counts,
          escalation_reason: escalation?.payload.reason ?? null,
          debug_artifact_id: escalation?.payload.artifact_id ?? null,
        };
      }),
    );
    for (const report of reports) {
      const current = server.service.store.get(report.mission_id);
      if (current.state !== report.status) {
        const events = server.service.store.events(report.mission_id);
        const escalation = events.findLast(
          (event) => event.type === "escalation",
        );
        report.status = current.state;
        report.escalation_reason = escalation?.payload.reason ?? null;
        report.debug_artifact_id = escalation?.payload.artifact_id ?? null;
        report.wall_elapsed_ms =
          escalation?.payload.wall_elapsed_ms ?? report.wall_elapsed_ms;
        report.active_elapsed_ms =
          escalation?.payload.active_elapsed_ms ?? report.active_elapsed_ms;
        report.event_counts = {};
        for (const event of events)
          report.event_counts[event.type] =
            (report.event_counts[event.type] || 0) + 1;
      }
    }
    writeFileSync(join(root, "summary.json"), JSON.stringify(reports, null, 2));
    process.stdout.write(JSON.stringify(reports) + "\n");
  } catch (error: any) {
    const code =
      typeof error?.message === "string" && /^[A-Z_0-9]+$/.test(error.message)
        ? error.message
        : "LIVE_CHECK_FAILED";
    process.stdout.write(JSON.stringify({ error: code }) + "\n");
    process.exitCode = 1;
  } finally {
    app?.close();
  }
}
await main();
process.exit(process.exitCode || 0);
