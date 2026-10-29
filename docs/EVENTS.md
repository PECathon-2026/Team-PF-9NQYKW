# DevPilot event and API contract

Each WebSocket message is a JSON object:

```json
{
  "id": 42,
  "ts": 1790000000000,
  "mission_id": "m_example",
  "type": "test_result",
  "agent": "sentinel",
  "task_id": null,
  "code_rev": "r1:sha256:<tree-hash>",
  "verified": true,
  "payload": {
    "check_id": "unit",
    "outcome": "passed",
    "exit_code": 0,
    "duration": 50,
    "isolation": "isolated"
  }
}
```

`id` is a globally increasing SQLite event ID, not a per-mission sequence. `ts` is Unix milliseconds. `task_id` and `code_rev` can be null. `verified` means the service observed the stated fact; it does not mean a test passed or a model conclusion is true. Plans, model messages, and model review conclusions are claims. Staleness is conveyed by separate events, without modifying the original event. The payload of each `test_result` includes `isolation`, either `isolated` or `unisolated`, identifying the configured runner. The frontend must block approval when a relevant test result is `unisolated`. `isolation` is not stamped on other event types. Unisolated missions do not emit `approval_needed`: they escalate with `ISOLATION_UNAVAILABLE`.

Connect to `/ws?mission=<id>` for replay followed by live events. `after=<event-id>` resumes strictly after that global ID; clients should deduplicate by `id`. `GET /missions/:id` returns the mission projection and its `watermark`.

## Payloads by type

The following describes fields the service emits. Fields identified as optional occur only for the stated variant. Consumers should tolerate additional fields as the contract grows.

| `type`            | Payload fields                                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mission_started` | `repo`, `request`, `base_hash`, `deadline` (Unix milliseconds), `suite_id` (string or null), `mode` (`multi` or `baseline`), `baseline_of` (mission ID or null), `paired_mission_id` (mission ID or null).                                                                                                      |
| `plan`            | `version`, `criteria`, `tasks`, `reason_event_ids`. Criteria and tasks are model claims; each task includes `id`, `title`, `role`, and `status`. The baseline `test_result` precedes the plan and is cited in `reason_event_ids`.                                                                               |
| `task_update`     | `task_id`, `previous_status`, `status`, `reason_event_ids`.                                                                                                                                                                                                                                                     |
| `agent_msg`       | Usually `to`, `message`, and optionally `evidence_event_ids`. Review completion also includes `findings`; security completion may include `scanner_findings` and `scanner_event_id`. A pairing announcement includes `baseline_of` and `paired_mission_id`.                                                     |
| `tool_call`       | `call_id`, `tool`, sanitized `arguments`, `job_id`. Edit content is not included in arguments.                                                                                                                                                                                                                  |
| `tool_result`     | `call_id`, `ok`, and either `data` or `error: {code}`. A nonzero test exit is an observed test failure, not a tool-execution error.                                                                                                                                                                             |
| `test_result`     | Project check: `check_id`, `outcome` (`passed` or `failed`), `exit_code`, `duration` in milliseconds, and optionally `phase: "baseline"`. Acceptance: `suite_id`, `outcome`, `criteria: [{id, passed}]`. `isolation` identifies the runner. Private suite source and raw private test output are not published. |
| `finding`         | `finding_id`, `severity`, `blocking` (boolean), `action` (`open`, `resolve`, or `sent_back`), `title`, `detail`, and `evidence_event_ids`. `sent_back` records that a blocking finding was returned to the editor for a repair cycle.                                                                           |
| `diff`            | `text` is the cumulative textual diff from the mission's original base to this revision; `artifact_id` identifies the same text, `base_hash` is the original tree hash, `revision` is the candidate revision, and `changed_paths` lists paths changed in this edit. Binary changes are summarized in text.      |
| `approval_needed` | `approval_id`, `evidence_ids`, `tree_hash`, and `decision: null`. The envelope's `code_rev` identifies the revision.                                                                                                                                                                                            |
| `approval_result` | The same `approval_id`, `evidence_ids`, and `tree_hash`, with `decision` set to `true` or `false`.                                                                                                                                                                                                              |
| `escalation`      | `reason`, `question`, `relevant_event_ids`, and `evidence_ids`.                                                                                                                                                                                                                                                 |
| `stale`           | `old_revision`, `new_revision`, `affected_evidence_ids`, `reason`.                                                                                                                                                                                                                                              |
| `usage`           | Exactly `{"per_agent": {"<agent>": {"turns": 0, "input_tokens": 0, "output_tokens": 0}}, "total": {"turns": 0, "input_tokens": 0, "output_tokens": 0}}`. Every event is a cumulative snapshot for the mission. A turn reservation and a later provider token report can each emit a snapshot.                   |
| `mission_done`    | `status` (`COMPLETED`, `REJECTED`, or `ESCALATED`); cumulative `per_agent` and `total` in the same shape as `usage`; `baseline_of`, `paired_mission_id`, `evidence_ids`, and `unresolved_findings`. `applied_revision` or `recovered` may be present.                                                           |

Previously recorded delta-form usage events are converted to cumulative snapshots when replayed, including on resumed connections. Acceptance `test_result` events publish only collected test IDs and boolean outcomes. The trusted suite is collected before candidate execution and run in a fresh pytest process that uses an RPC proxy to a separate candidate worker. Missing or malformed JUnit, a changed collection, unexpected IDs or exit status, and timeouts do not satisfy the acceptance gate. Infrastructure failures can instead produce an `escalation` and `mission_done` without a `test_result`. In unisolated mode the shared host account and filesystem are not a tamper-proof boundary.

Tokens come from the provider's reported `prompt_tokens` and `completion_tokens`, not an estimate of text length. Totals contain only counts actually reported before the mission ended. An absent provider usage report contributes zero to the reported total and is **not** evidence that no tokens were used. Mock responses may include scripted usage; otherwise they report no token counts. Every attempted model call consumes a turn even when the call fails or times out.

## Missions, pairing, and artifacts

`POST /missions` accepts `{"repo":"stock","request":"<registered request>"}` and returns `202 {"mission_id":"m_...","id":"m_..."}`, with identical IDs. `mode` can be `multi` or `baseline`.

To link a baseline, post `{"repo":"stock","request":"<same request>","mode":"baseline","paired_mission_id":"<multi-mission-id>"}`. The referenced mission must be a multi-agent run for the same repo and request, with no existing pair. The baseline starts from an independent copy of that run's original base and uses the same suite; a changed or unavailable base or suite rejects pairing. A baseline's `baseline_of` and `paired_mission_id` both point to the multi-agent run; the multi-agent projection's `paired_mission_id` points to the baseline. A pairing announcement is also appended to the multi-agent event stream. The multi-agent run's already-emitted `mission_started` event is not rewritten.

When a structured model reply is rejected, an `agent_msg` contains a schema-specific reason and an `artifact_id` for a redacted, truncated debug file at `runtime/artifacts/<mission-id>/<artifact-id>.txt`. Raw reply text and model reasoning are not put into the event stream; debug files are not exposed by the artifact API. A second invalid reply escalates with `MODEL_RESPONSE_INVALID` and cites the rejection messages and associated tool events.

`GET /missions/:id/artifacts/:artifactId` returns the artifact's UTF-8 text with `Content-Type: text/plain` and `X-Content-Type-Options: nosniff`. Artifact IDs are scoped to the mission: an unknown or mismatched ID returns `404`. Diff artifacts contain exactly the `text` from their `diff` event. Private acceptance artifacts are not exposed.

`POST /missions/:id/approve` accepts `{"approved":true}` or `{"approved":false}` only for the outstanding approval. After a decision, any further approval or rejection returns `409`. Approval is for the exact revision and tree hash in `approval_needed`.

Each mission starts with an independent seed copy and applies only to `runtime/missions/<mission-id>/target/current`. An unchanged or reverted candidate escalates with `NO_CHANGES` and never requests approval. In unisolated mode, even a passing candidate escalates with `ISOLATION_UNAVAILABLE` rather than requesting approval. For the ambiguous titles scenario, `relevant_event_ids` and `evidence_ids` include the `TOOL_DISABLED` result event ID.

Cross-origin requests require an exact origin in `DEVPILOT_ALLOWED_ORIGINS`, a comma-separated list; its default is `http://localhost:5173,http://127.0.0.1:5173`. Same-origin requests are also accepted. Allowed browser preflights and responses include CORS headers; other origins are rejected.
