import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRegistry } from "../src/registry";
import { startServer } from "../src/server";
import { makeRunner, suiteDigest } from "../src/runner";

const fixtureRoot = resolve(
  process.env.DEVPILOT_FIXTURES_DIR || "../devpilot-fixtures",
);
const registry = loadRegistry("config/repositories.json", fixtureRoot);
const root = mkdtempSync(join(tmpdir(), "devpilot-scenarios-"));
let app: ReturnType<typeof startServer>;
let previousFlag: string | undefined;

beforeAll(() => {
  previousFlag = process.env.DEVPILOT_ALLOW_UNISOLATED;
  process.env.DEVPILOT_ALLOW_UNISOLATED = "1";
  app = startServer({ root, registry, mock: true, port: 0 });
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
  if (previousFlag === undefined) delete process.env.DEVPILOT_ALLOW_UNISOLATED;
  else process.env.DEVPILOT_ALLOW_UNISOLATED = previousFlag;
});
async function waitFor(fn: () => boolean) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(20);
  }
  throw Error("mission did not reach the expected state");
}
async function post(path: string, body: unknown) {
  return fetch(`http://127.0.0.1:${app.server.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("supplied fixture missions", () => {
  for (const scenario of ["cart", "stats", "stock", "notes", "titles"]) {
    test(`${scenario}: real project and private pytest checks`, async () => {
      const config = registry[scenario];
      const request = Object.keys(config.requests)[0]!;
      const scenarioConfig = config.requests[request];
      if (scenarioConfig.suite)
        expect(suiteDigest(scenarioConfig.suite)).toBe(
          scenarioConfig.suite_sha256,
        );
      const response = await post("/missions", { repo: scenario, request });
      expect(response.status).toBe(202);
      const { mission_id } = (await response.json()) as any;
      await waitFor(() =>
        ["AWAITING_APPROVAL", "ESCALATED"].includes(
          app.service.store.get(mission_id).state,
        ),
      );
      const mission = app.service.store.get(mission_id);
      const events = app.service.store.events(mission_id);
      expect(
        events.every((e) =>
          e.type === "test_result"
            ? e.payload.isolation === "unisolated"
            : !("isolation" in e.payload),
        ),
      ).toBe(true);
      if (scenario === "titles") {
        expect(mission.state).toBe("ESCALATED");
        expect(
          events.some(
            (e) =>
              e.type === "tool_result" &&
              e.payload.error?.code === "TOOL_DISABLED",
          ),
        ).toBe(true);
        expect(
          events.some(
            (e) =>
              e.type === "escalation" &&
              e.payload.reason === "AMBIGUOUS_REQUEST" &&
              e.payload.question.includes("?"),
          ),
        ).toBe(true);
        const disabled = events.filter(
          (e) =>
            e.type === "tool_result" &&
            e.payload.error?.code === "TOOL_DISABLED",
        );
        const escalation = events.find(
          (e) =>
            e.type === "escalation" && e.payload.reason === "AMBIGUOUS_REQUEST",
        )!;
        expect(disabled.length).toBeGreaterThan(0);
        for (const event of disabled) {
          expect(escalation.payload.relevant_event_ids).toContain(event.id);
          expect(escalation.payload.evidence_ids).toContain(event.id);
        }
        return;
      }
      if (mission.state !== "ESCALATED") {
        throw Error(
          `mission escalated: ${JSON.stringify(events.filter((e) => ["escalation", "test_result"].includes(e.type)).map((e) => e.payload))}`,
        );
      }
      const testResults = events.filter((e) => e.type === "test_result");
      expect(testResults.length).toBeGreaterThan(0);
      expect(
        testResults.every((e) => e.payload.isolation === "unisolated"),
      ).toBe(true);
      const acceptance = events.find(
        (e) => e.type === "test_result" && e.payload.suite_id,
      );
      expect(acceptance?.verified).toBe(true);
      expect(acceptance?.payload.outcome).toBe("passed");
      expect(acceptance?.payload.criteria.length).toBeGreaterThan(0);
      expect(
        acceptance?.payload.criteria.every(
          (c: any) => Object.keys(c).sort().join(",") === "id,passed",
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain(scenarioConfig.suite);
      if (scenario === "stock") {
        const baseline = events.find(
          (e) => e.type === "test_result" && e.payload.phase === "baseline",
        );
        expect(baseline?.payload.outcome).toBe("failed");
        const plan = events.find((e) => e.type === "plan")!;
        expect(baseline!.id).toBeLessThan(plan.id);
        expect(plan.payload.reason_event_ids).toContain(baseline!.id);
        const tasks = plan.payload.tasks as any[];
        expect(
          tasks.every(
            (task) =>
              typeof task.role === "string" && task.status === "pending",
          ),
        ).toBe(true);
        for (const event of events.filter((e) => e.type === "task_update")) {
          expect(
            tasks.some(
              (task) =>
                task.id === event.task_id && task.id === event.payload.task_id,
            ),
          ).toBe(true);
        }
        expect(
          events.some(
            (e) =>
              e.type === "agent_msg" &&
              e.payload.evidence_event_ids?.includes(baseline?.id),
          ),
        ).toBe(true);
        expect(
          events.some(
            (e) =>
              e.type === "stale" &&
              e.payload.affected_evidence_ids.includes(baseline?.id),
          ),
        ).toBe(true);
      }
      expect(events.some((e) => e.type === "approval_needed")).toBe(false);
      expect(
        events.some(
          (e) =>
            e.type === "escalation" &&
            e.payload.reason === "ISOLATION_UNAVAILABLE",
        ),
      ).toBe(true);
      expect(
        (await post(`/missions/${mission_id}/approve`, { approved: true }))
          .status,
      ).toBe(409);
      expect(
        readFileSync(join(mission.base_ref, `${scenario}.py`), "utf8"),
      ).toBe(readFileSync(join(config.path, `${scenario}.py`), "utf8"));
    }, 25000);
  }
  test("isolation fails closed when no container engine exists", () => {
    if (!Bun.which("docker") && !Bun.which("podman"))
      expect(() => makeRunner(false)).toThrow("SANDBOX_UNAVAILABLE");
  });
  test("titles baseline escalation cites the disabled search result", async () => {
    const request = Object.keys(registry.titles.requests)[0]!;
    const response = await post("/missions", {
      repo: "titles",
      request,
      mode: "baseline",
    });
    const { mission_id } = (await response.json()) as any;
    await waitFor(
      () => app.service.store.get(mission_id).state === "ESCALATED",
    );
    const events = app.service.store.events(mission_id);
    const disabled = events.find(
      (e) =>
        e.type === "tool_result" && e.payload.error?.code === "TOOL_DISABLED",
    )!;
    const escalation = events.find((e) => e.type === "escalation")!;
    expect(disabled).toBeDefined();
    expect(escalation.payload.reason).toBe("AMBIGUOUS_REQUEST");
    expect(escalation.payload.relevant_event_ids).toContain(disabled.id);
    expect(escalation.payload.evidence_ids).toContain(disabled.id);
  }, 20000);
});
