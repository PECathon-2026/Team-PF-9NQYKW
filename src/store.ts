import { Database } from "bun:sqlite";
export type Event = {
  id: number;
  ts: number;
  mission_id: string;
  type: string;
  agent: string;
  task_id: string | null;
  code_rev: string | null;
  verified: boolean;
  payload: any;
};
export class Store {
  db: Database;
  isolation: "isolated" | "unisolated";
  listeners = new Set<(e: Event) => void>();
  constructor(path: string, isolation: "isolated" | "unisolated" = "isolated") {
    this.isolation = isolation;
    this.db = new Database(path, { create: true });
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, repo TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL, base_hash TEXT NOT NULL, base_ref TEXT NOT NULL, current_rev TEXT NOT NULL, snapshot TEXT NOT NULL, suite_hash TEXT, suite TEXT, mode TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0 CHECK(turns BETWEEN 0 AND 20), fixes INTEGER NOT NULL DEFAULT 0 CHECK(fixes BETWEEN 0 AND 3), created INTEGER NOT NULL, deadline INTEGER NOT NULL, approval TEXT, decision INTEGER, evidence TEXT NOT NULL DEFAULT '[]');
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, mission_id TEXT NOT NULL REFERENCES missions(id), type TEXT NOT NULL, agent TEXT NOT NULL, task_id TEXT, code_rev TEXT, verified INTEGER NOT NULL CHECK(verified IN (0,1)), payload TEXT NOT NULL CHECK(json_valid(payload)));
 CREATE INDEX IF NOT EXISTS events_mission ON events(mission_id,id);
 CREATE TABLE IF NOT EXISTS failures(mission_id TEXT NOT NULL, call_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(mission_id,call_id));
 CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY REFERENCES events(id), mission_id TEXT NOT NULL, code_rev TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)));
 CREATE INDEX IF NOT EXISTS evidence_rev ON evidence(mission_id,code_rev,stale);
 CREATE TABLE IF NOT EXISTS apply_intents(mission_id TEXT PRIMARY KEY, target TEXT NOT NULL, state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), kind TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS usage(mission_id TEXT NOT NULL REFERENCES missions(id), agent TEXT NOT NULL, model_turns INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(mission_id, agent));`);
    const columns = this.db.query("PRAGMA table_info(missions)").all() as {
      name: string;
    }[];
    for (const name of ["baseline_of", "paired_mission_id"]) {
      if (!columns.some((column) => column.name === name))
        this.db.exec(
          `ALTER TABLE missions ADD COLUMN ${name} TEXT REFERENCES missions(id)`,
        );
    }
  }
  get(id: string): any {
    return this.db.query("SELECT * FROM missions WHERE id=?").get(id);
  }
  usage(id: string) {
    const rows = this.db
      .query(
        "SELECT agent, model_turns, prompt_tokens, completion_tokens FROM usage WHERE mission_id=? ORDER BY agent",
      )
      .all(id) as {
      agent: string;
      model_turns: number;
      prompt_tokens: number;
      completion_tokens: number;
    }[];
    const perAgent: Record<
      string,
      { turns: number; input_tokens: number; output_tokens: number }
    > = {};
    let modelTurns = 0,
      prompt = 0,
      completion = 0;
    for (const row of rows) {
      perAgent[row.agent] = {
        turns: row.model_turns,
        input_tokens: row.prompt_tokens,
        output_tokens: row.completion_tokens,
      };
      modelTurns += row.model_turns;
      prompt += row.prompt_tokens;
      completion += row.completion_tokens;
    }
    return {
      per_agent: perAgent,
      total: {
        turns: modelTurns,
        input_tokens: prompt,
        output_tokens: completion,
      },
    };
  }
  event(
    id: string,
    type: string,
    agent: string,
    payload: any = {},
    rev: string | null = null,
    verified = false,
    task: string | null = null,
  ): Event {
    if (type === "test_result")
      payload = { ...payload, isolation: this.isolation };
    else {
      const { isolation: _isolation, ...rest } = payload;
      payload = rest;
    }
    const ts = Date.now();
    const result = this.db
      .query(
        "INSERT INTO events(ts,mission_id,type,agent,task_id,code_rev,verified,payload) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        ts,
        id,
        type,
        agent,
        task,
        rev,
        verified ? 1 : 0,
        JSON.stringify(payload),
      );
    const event: Event = {
      id: Number(result.lastInsertRowid),
      ts,
      mission_id: id,
      type,
      agent,
      task_id: task,
      code_rev: rev,
      verified,
      payload,
    };
    for (const fn of this.listeners) fn(event);
    return event;
  }
  events(id: string, after = 0): Event[] {
    // Earlier usage events were deltas. Read prior usage records even on a
    // resumed replay so they can be presented as cumulative snapshots without
    // changing the append-only event log.
    const rows = this.db
      .query(
        "SELECT * FROM events WHERE mission_id=? AND (id>? OR type='usage') ORDER BY id",
      )
      .all(id, after) as any[];
    let perAgent: Record<
      string,
      { turns: number; input_tokens: number; output_tokens: number }
    > = {};
    const result: Event[] = [];
    for (const row of rows) {
      let payload = JSON.parse(row.payload);
      if (row.type !== "test_result") delete payload.isolation;
      if (row.type === "usage") {
        if (payload.per_agent && payload.total) {
          perAgent = structuredClone(payload.per_agent);
          payload = {
            per_agent: structuredClone(perAgent),
            total: payload.total,
          };
        } else if (payload.agent_totals && payload.totals) {
          const agent = payload.agent_totals;
          perAgent[row.agent] = {
            turns: agent.model_turns,
            input_tokens: agent.tokens.prompt,
            output_tokens: agent.tokens.completion,
          };
          payload = {
            per_agent: structuredClone(perAgent),
            total: {
              turns: payload.totals.model_turns,
              input_tokens: payload.totals.tokens.prompt,
              output_tokens: payload.totals.tokens.completion,
            },
          };
        }
      }
      if (row.id > after)
        result.push({ ...row, verified: !!row.verified, payload });
    }
    return result;
  }
  close() {
    this.db.close();
  }
}
