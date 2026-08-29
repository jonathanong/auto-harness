# Auto Harness dispatch action

`operation: dispatch` (the default) creates a session and returns immediately. `operation: resume`
continues a prior session on its pinned host. The same action also owns the authenticated service
account's principal session drain for a single repository. It never lists or individually cancels
sessions in GitHub Actions: the control plane owns that durable work. Replace `<sha>` below with a
reviewed full commit SHA from `main`, then deliberately update it when adopting a newer revision. Do
not use the moving `main` ref.

```yaml
- uses: jonathanong/auto-harness/actions/dispatch@<sha>
  with:
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    prompt: Review this pull request
    target: '{"providerName":"codex"}'
    timeout: "1800"
    concurrency-id: github-${{ github.run_id }}
    queue-ttl-seconds: "3600"
    priority: "10"
```

The action returns as soon as the session is accepted. Use the `session-id`, `session-url`, and
`created` outputs for annotations or later automation.

`target` and `fallbacks` accept `providerId`/`commandId` values or human-readable
`providerName`/`commandName` values. The bundled client resolves each name through the control-plane
catalog before dispatch and fails if a name is missing or ambiguous.

Every dispatch, resume, and drain request is bounded by `request-timeout-seconds`, including
receiving the response body. It defaults to `30` seconds and must be a finite positive number no
greater than `300`. The wait operation uses the shorter of this request timeout and the remaining
`poll-timeout-seconds` deadline for each status request; it does not retry a timed-out request.

## Resume

Continues a prior **terminal** session that actually ran — pass the source `session-id` from an
already-finished run (Slack, a stored comment, or a status check performed after the original
dispatch completed). The control plane rejects resuming a session that has not yet reached a
terminal status, a session that expired or was cancelled before it was ever assigned a host (there
is no route to pin), and a session created by Auto Harness's schedule feature. Native resume
pins to the source host and route; if that route becomes unavailable, the control plane clears the
pin and routes a fresh run through the session's original target/fallback chain. `timeout` and
`priority` are optional overrides that default to the source session's values; an omitted `prompt`
does not replay the source session's original prompt, it falls back to the agent's native
resume/continue behavior. `concurrency-id` is not an override: if supplied, it must exactly match
the source session's inherited identity, and any other value is rejected.

```yaml
- name: Resume a completed session
  uses: jonathanong/auto-harness/actions/dispatch@<sha>
  with:
    operation: resume
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    session-id: ${{ steps.load-completed-session.outputs.session-id }}
    prompt: "Continue: also fix the edge case in parseDate"
```

`repository-id` is not required for resume — the control plane resolves it from the source session.

## Principal session drain

Cancels this service account's own queued and running sessions for one repository, then fences
new admission from that same account until released — **not** repository drain or host drain; see
[Principal session drains](../../docs/api.md#principal-session-drains) for the full
disambiguation. Use one stable idempotency key per caller operation. Start returns the durable
`operation-id` and
`status-url`; `get-drain` makes one bounded progress request and `wait-for-drain` succeeds only
when the control plane returns `succeeded`. It fails closed for failed, released, unknown, or
malformed results. Release is explicit, including after a failed drain, so release must follow
whatever caller-side failure handling records that result.

```yaml
- name: Start this service account's principal session drain
  id: drain
  uses: jonathanong/auto-harness/actions/dispatch@<sha>
  with:
    operation: start-drain
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    idempotency-key: deploy-${{ github.run_id }}

- name: Wait for terminal proof
  id: drain-status
  uses: jonathanong/auto-harness/actions/dispatch@<sha>
  with:
    operation: wait-for-drain
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    session-drain-id: ${{ steps.drain.outputs.operation-id }}
    poll-interval-seconds: "5"
    poll-timeout-seconds: "900"

- name: Reopen this principal's admission after recording the result
  if: always()
  uses: jonathanong/auto-harness/actions/dispatch@<sha>
  with:
    operation: release-drain
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    session-drain-id: ${{ steps.drain.outputs.operation-id }}
```

Drain outputs are `operation-id`, an absolute `status-url`, `drain-status`, `drain-terminal`,
`queued-count`, `running-count`, `cancelled-count`, and `failure-code`. A normal `dispatch` that
loses to a principal drain fails with a message containing the durable drain ID and status URL.

## Development

The typed source in `src/` imports the workspace `auto-harness-client`; the checked-in
`dist/index.js` bundles that client because Actions cannot depend on this repository's
`node_modules` at runtime. Run `pnpm build:dispatch-action` after source or client changes.
`pnpm check:dispatch-action` fails when the committed bundle is stale.
