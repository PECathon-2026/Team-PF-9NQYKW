import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer } from "../src/server";
import { loadRegistry } from "../src/registry";

// One isolated mission; never print provider responses, credentials, or headers.
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
    const request = Object.keys(registry.stock.requests)[0]!;
    const runtimeParent = resolve(process.env.DEVPILOT_RUNTIME || "runtime");
    mkdirSync(runtimeParent, { recursive: true });
    const root = mkdtempSync(join(runtimeParent, "live-stock-"));
    app = startServer({ root, registry, mock: false, port: 8797 });
    if (app.service.store.isolation !== "isolated")
      throw Error("ISOLATION_UNAVAILABLE");
    const response = await fetch("http://127.0.0.1:8797/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "stock", request }),
    });
    if (response.status !== 202) throw Error("MISSION_CREATE_FAILED");
    const { mission_id } = (await response.json()) as { mission_id: string };
    const until = Date.now() + 155000;
    while (
      Date.now() < until &&
      !["AWAITING_APPROVAL", "COMPLETED", "REJECTED", "ESCALATED"].includes(
        app.service.store.get(mission_id).state,
      )
    )
      await Bun.sleep(250);
    const mission = app.service.store.get(mission_id);
    const events = app.service.store.events(mission_id);
    const counts: Record<string, number> = {};
    for (const event of events)
      counts[event.type] = (counts[event.type] || 0) + 1;
    const reason = events.findLast((e) => e.type === "escalation")?.payload
      .reason;
    const report = {
      status: mission.state,
      approval_needed: events.some((e) => e.type === "approval_needed"),
      event_counts: counts,
      escalation_reason:
        typeof reason === "string" && /^[A-Z_0-9]+$/.test(reason)
          ? reason
          : null,
    };
    writeFileSync(join(root, "summary.json"), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report) + "\n");
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
