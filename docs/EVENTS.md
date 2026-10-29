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

`id` is a globally increasing SQLite event ID, not a per-mission sequence. `ts` is Unix milliseconds. `task_id` and `code_rev` can be null. `verified` means the service observed the stated fact; it does not mean a test passed or a model conclusion is true. Plans, model messages, and model review conclusions are claims. Staleness is conveyed by separate events, without modifying the original event. Every payload also includes `isolation`, either `isolated` or `unisolated`; it records the runner configured for that mission.

Connect to `/ws?mission=<id>` for replay followed by live events. `after=<event-id>` resumes strictly after that global ID; clients should deduplicate by `id`. `GET /missions/:id` returns the mission projection and its `watermark`.

## Payloads by type

The following describes fields the service emits. Fields identified as optional occur only for the stated variant. Consumers should tolerate additional fields as the contract grows.

| `type`            | Payload fields                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mission_started` | `repo`, `request`, `base_hash`, `deadline` (Unix milliseconds), `suite_id` (string or null), `mode` (`multi` or `baseline`), `baseline_of` (mission ID or null), `paired_mission_id` (mission ID or null).                                                                                                                                             |
| `plan`            | `version`, `criteria`, `tasks`, `reason_event_ids`. Criteria and tasks are model claims.                                                                                                                                                                                                                                                               |
| `task_update`     | `task_id`, `previous_status`, `status`, `reason_event_ids`.                                                                                                                                                                                                                                                                                            |
| `agent_msg`       | Usually `to`, `message`, and optionally `evidence_event_ids`. Review completion also includes `findings`; security completion may include `scanner_findings` and `scanner_event_id`. A pairing announcement includes `baseline_of` and `paired_mission_id`.                                                                                            |
| `tool_call`       | `call_id`, `tool`, sanitized `arguments`, `job_id`. Edit content is not included in arguments.                                                                                                                                                                                                                                                         |
| `tool_result`     | `call_id`, `ok`, and either `data` or `error: {code}`. A nonzero test exit is an observed test failure, not a tool-execution error.                                                                                                                                                                                                                    |
| `test_result`     | Project check: `check_id`, `outcome` (`passed` or `failed`), `exit_code`, `duration` in milliseconds, and optionally `phase: "baseline"`. Acceptance: `suite_id`, `outcome`, `criteria: [{id, passed}]`. Private suite source and raw private test output are not published.                                                                           |
| `finding`         | `finding_id`, `severity`, `blocking` (boolean), `action` (`open`, `resolve`, or `sent_back`), `title`, `detail`, and `evidence_event_ids`. `sent_back` records that a blocking finding was returned to the editor for a repair cycle.                                                                                                                  |
| `diff`            | `text` is the cumulative textual diff from the mission's original base to this revision; `artifact_id` identifies the same text, `base_hash` is the original tree hash, `revision` is the candidate revision, and `changed_paths` lists paths changed in this edit. Binary changes are summarized in text.                                             |
| `approval_needed` | `approval_id`, `evidence_ids`, `tree_hash`, and `decision: null`. The envelope's `code_rev` identifies the revision.                                                                                                                                                                                                                                   |
| `approval_result` | The same `approval_id`, `evidence_ids`, and `tree_hash`, with `decision` set to `true` or `false`.                                                                                                                                                                                                                                                     |
| `escalation`      | `reason`, `question`, `relevant_event_ids`.                                                                                                                                                                                                                                                                                                            |
| `stale`           | `old_revision`, `new_revision`, `affected_evidence_ids`, `reason`.                                                                                                                                                                                                                                                                                     |
| `usage`           | `model_turns` and `tokens: {prompt, completion}` are **deltas** for the envelope's agent. `agent_totals` holds that agent's cumulative `{model_turns, tokens}`. `totals` holds mission-wide cumulative `{model_turns, tokens}`. A turn reservation emits a delta of one turn and zero tokens; a reported token usage emits a separate zero-turn delta. |
| `mission_done`    | `status` (`COMPLETED`, `REJECTED`, or `ESCALATED`); mission-wide `model_turns` and `tokens: {prompt, completion}`; `by_agent`, an object mapping agent names to `{model_turns, tokens}`; `baseline_of` and `paired_mission_id`; `evidence_ids` and `unresolved_findings`. `applied_revision` or `recovered` may be present.                            |

Tokens come from the provider's reported `prompt_tokens` and `completion_tokens`, not an estimate of text length. Totals contain only counts actually reported before the mission ended. An absent provider usage report contributes zero to the reported total and is **not** evidence that no tokens were used. Mock responses may include scripted usage; otherwise they report no token counts. Every attempted model call consumes a turn even when the call fails or times out.

## Missions, pairing, and artifacts

`POST /missions` accepts `{"repo":"stock","request":"<registered request>"}` and returns `202 {"mission_id":"m_...","id":"m_..."}`, with identical IDs. `mode` can be `multi` or `baseline`.

To link a baseline, post `{"repo":"stock","request":"<same request>","mode":"baseline","paired_mission_id":"<multi-mission-id>"}`. The referenced mission must be a multi-agent run for the same repo and request, with no existing pair. The baseline starts from an independent copy of that run's original base and uses the same suite; a changed or unavailable base or suite rejects pairing. A baseline's `baseline_of` and `paired_mission_id` both point to the multi-agent run; the multi-agent projection's `paired_mission_id` points to the baseline. A pairing announcement is also appended to the multi-agent event stream. The multi-agent run's already-emitted `mission_started` event is not rewritten.

`GET /missions/:id/artifacts/:artifactId` returns the artifact's UTF-8 text with `Content-Type: text/plain` and `X-Content-Type-Options: nosniff`. Artifact IDs are scoped to the mission: an unknown or mismatched ID returns `404`. Diff artifacts contain exactly the `text` from their `diff` event. Private acceptance artifacts are not exposed.

`POST /missions/:id/approve` accepts `{"approved":true}` or `{"approved":false}` only for the outstanding approval. Repeating the same decision is idempotent; a conflicting decision returns `409`. Approval is for the exact revision and tree hash in `approval_needed`.
