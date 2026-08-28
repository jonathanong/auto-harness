# Auto Harness dispatch action

`operation: dispatch` (the default) creates a session and returns immediately. The same action also
owns the authenticated service account's principal session drain for a single repository. It never
lists or individually cancels sessions in GitHub Actions: the control plane owns that durable work.
Pin every use to the reviewed full commit SHA shown below, then deliberately replace that SHA when
adopting a newer revision. Do not use the moving `main` ref.

```yaml
- uses: jonathanong/auto-harness/actions/dispatch@4727acc51fd29e92a6a34dbcf9c05255ad9658e8
  with:
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    prompt: Review this pull request
    target: '{"providerId":"<provider-uuid>"}'
    timeout: "1800"
    concurrency-id: github-${{ github.run_id }}
```

The action returns as soon as the session is accepted. Use the `session-id`, `session-url`, and
`created` outputs for annotations or later automation.

Every dispatch and drain request is bounded by `request-timeout-seconds`, including receiving the
response body. It defaults to `30` seconds and must be a finite positive number no greater than
`300`. The wait operation uses the shorter of this request timeout and the remaining
`poll-timeout-seconds` deadline for each status request; it does not retry a timed-out request.

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
  uses: jonathanong/auto-harness/actions/dispatch@4727acc51fd29e92a6a34dbcf9c05255ad9658e8
  with:
    operation: start-drain
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    idempotency-key: deploy-${{ github.run_id }}

- name: Wait for terminal proof
  id: drain-status
  uses: jonathanong/auto-harness/actions/dispatch@4727acc51fd29e92a6a34dbcf9c05255ad9658e8
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
  uses: jonathanong/auto-harness/actions/dispatch@4727acc51fd29e92a6a34dbcf9c05255ad9658e8
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
