# Required autonomous feedback

All autonomous Harness roots, children, schedules, workspace sessions, and resumed/fallback attempts use mandatory reporting. A prompt or session metadata cannot select an interactive mode or disable the policy. Interactive developer tooling has its own bounded local-outbox behavior; it is not a Harness execution mode.

The trusted controller performs a fresh Blackboard append and readback before sending an assignment, so repository setup and hooks cannot start during a reporting outage. It performs another fresh check at the daemon's command-start boundary, bound to the current session/attempt and host connection. Replayed acknowledgements authorize only that same committed attempt. Admission has the existing two-second sweep budget; unavailable reporting leaves work queued and visibly blocked, without holding execution resources.

## Deployment configuration

Deploy the reviewed shared `vouchington-tooling/agent-blackboard` release first, then pin the published version in `services/api`. The API has a production `agent-blackboard` SDK dependency; Node 24 and the CDK bundle include that SDK. A private validation tarball is never a production dependency or registry release.

AWS uses the trusted SSM `SecureString` named by `HARNESS_BLACKBOARD_SSM_PARAM` (default `/auto-harness/blackboard-reporting`). Its JSON is deployment configuration, not a repository/session setting. Only REST, WebSocket, and cron controllers may read/decrypt the scoped parameter. Local API uses `HARNESS_BLACKBOARD_CONFIG` with the same JSON. Keep it in an uncommitted controller environment file; never put it in host inventory, setup profiles, workflow environments, or child CLI homes.

```json
{
  "schemaVersion": 1,
  "version": 1,
  "url": "https://blackboard.example.test",
  "token": "replace-with-dedicated-non-admin-writer",
  "policies": [
    {
      "repositoryId": "configured-repository-id",
      "repository": "owner/repository",
      "principalIds": ["configured-principal-id"]
    },
    {
      "workspacePoolId": "configured-workspace-pool-id",
      "repository": "owner/workspace-owner",
      "principalIds": ["configured-principal-id"]
    }
  ]
}
```

Each policy selects exactly one repository or workspace pool and explicit permitted principals. `repository` is the operator's real reporting repository attribution, including non-Git workspace ownership; the controller never invents it. The `system` principal must be explicitly allowed for principal-less internal work. Missing/invalid configuration or unmatched scopes fail closed. A working health endpoint advertises `blackboardFeedbackProtocol: 1`; this capability check does not authorize an attempt or replace the fresh write/readback.

New sessions capture the selected policy version, repository attribution, and trusted `HARNESS_BUILD_VERSION` (or explicit `unknown`) for stable reporting identity. After adding or changing a policy, create a new session or resume a terminal repository session through the existing API. Unconfigured queued work cannot acquire policy through its prompt. Native resume creates a new session ID and keeps the old terminal row; workspace and scheduled native resume remain unsupported by the existing contract.

The supported local API uses DynamoDB Local. An in-memory simulation cannot authorize autonomous work with the production reporting controller because it lacks durable terminal storage/outbox. Standalone `run-session --file`, direct-run runtime exports, and their smoke bridges are retired; start the connected daemon and dispatch through the existing API.

## Evidence producer and privacy

The host creates a private temporary feedback file and supplies `HARNESS_FEEDBACK_PATH` and `HARNESS_FEEDBACK_INSTRUCTIONS` to the command/hook. For supported providers, trusted argv materialization identifies the exact prompt spans; the host inserts instructions there, including native-resume prompts that precede options. It never guesses the last argument. Custom commands receive the explicit environment/hook contract.

The current `SessionFeedback` schema in [session-feedback.ts](../modules/shared/src/session-feedback.ts) limits the file to 8 KiB, twenty findings, ten tool assessments, and 256-byte sanitized observations/reasons. Architecture, sandbox, and tools each require an assessment plus inspected scope or an honest unassessed/unavailable reason. Applicable tools have used/skipped/unavailable reasons. Complete evidence requires all three areas assessed, coherent findings, and zero dropped observations. Negative observations are scoped claims, not a blanket guarantee.

The collector rejects symlinks, nonregular/multiply-linked files, oversize data, invalid UTF-8, extra fields, and secret-shaped text. It forwards only the validated schema. Commands, prompts, raw logs, environment dumps, arbitrary metadata, and absolute evidence paths are excluded. `AGENT_BLACKBOARD_*` is reserved across allowlists, execution profiles, setup snapshots/cache, hooks, commands, and result probes. The dedicated writer credential never reaches those processes.

A terminal hook may replace the file. The host preserves earlier validated observations and merges them with post-hook evidence; duplicate snapshots are idempotent. Dropped counts are cumulative lower bounds, merged by maximum plus new truncation, and make coverage partial. A category observed but dropped may retain its finding assessment only with partial coverage and a nonzero drop count. Deferred hooks preserve evidence until actual settlement or cleanup; the controller waits for settled hook/claim state before enqueueing.

## Delivery, repair, and completion

Committed Sessions `NEW_IMAGE` stream events feed the existing cron Lambda. The handler validates the exact table stream ARN and reads only allowlisted historical fields. It never logs or transports the raw image. Terminal snapshot identity and sanitized envelope are frozen in existing `WebhookDeliveries`, so later state changes or a deployment retry cannot alter the body for the same `sourceEventId`. The current trusted policy still authorizes delivery; child evidence cannot override controller failure, cancellation, or timeout outcomes.

The outbox uses independent `state-dueAt` queue lanes. Ordinary webhooks retain their existing attempt ceiling. Validated Blackboard deliveries retry indefinitely with bounded per-tick work and capped backoff, preserving the same immutable event after lost acknowledgements. Transient outages remain pending; invalid current authorization is visibly blocked. A controller starts a delivery only with at least twenty-five seconds of Lambda time remaining. Reporting never waits to release hosts, slots, worktrees, provider leases, or cancellation resources.

A dedicated `ReportingRepairCheckpoints` table leases one versioned cursor per terminal status. Cron consumes one existing indexed session page per status, rechecks authoritative rows, and advances only after all page snapshots enqueue durably. Crashes and lease loss repeat the page safely. Invalid or changed cursor contracts restart the traversal. This repairs outages beyond stream retention without scans, Actions polling, a new observer service, or a telemetry endpoint. Session log archival retains the session rows and does not remove this repair evidence.

Session API/UI `reporting` exposes delivery, evidence coverage, and reporting completion separately from work status. Failure, queued cancellation, timeout, no output, host loss, expiry, and unavailable feedback produce honest final records. Successful/no-change work without complete valid feedback remains visibly incomplete even after a synthesized record delivers. A terminal business result therefore does not imply reporting completion.

Foundation changes (Sessions stream and repair table; delivery uses the existing indexed outbox) and runtime secret configuration are deployment prerequisites. This code does not create the writer credential or deploy those resources automatically.

The dedicated token grants non-admin append/read access. Repository, workspace, and principal scope are enforced by the trusted controller policy; the token example does not imply provider-enforced repository scoping.

The retired in-memory phase3 smoke commands are replaced by
`pnpm exec vitest run --project dynamo integration/blackboard-websocket-dynamo.test.ts`.
That real DynamoDB/HTTP Blackboard/WebSocket boundary verifies feature checkout,
terminal hook context, command rejection, failed-hook outcome preservation, and verified receipts.
The explicit test-only loopback fixture remains in `scripts/resume-ref-e2e.test.ts`;
it is a test simulation and does not expose an autonomous execution command.
