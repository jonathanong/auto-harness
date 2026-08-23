# Auto Harness dispatch action

`operation: dispatch` (the default) creates a session and returns immediately. The same action also
owns the authenticated service account's principal session drain for a single repository. It never
lists or individually cancels sessions in GitHub Actions: the control plane owns that durable work.

```yaml
- uses: jonathanong/auto-harness/actions/dispatch@512d03c89dd3511a0d1f644692767371f9a04ce2
  with:
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    prompt: Review this pull request
    target: '{"providerId":"codex"}'
    timeout: "1800"
    concurrency-id: github-${{ github.run_id }}
```

The action returns as soon as the session is accepted. Use the `session-id`, `session-url`, and
`created` outputs for annotations or later automation.

## Principal session drain

Use one stable idempotency key per caller operation. Start returns the durable `operation-id` and
`status-url`; `get-drain` makes one bounded progress request and `wait-for-drain` succeeds only
when the control plane returns `succeeded`. It fails closed for failed, released, unknown, or
malformed results. Release is explicit, including after a failed drain, so release must follow
whatever caller-side failure handling records that result.

```yaml
- name: Start this service account's repository drain
  id: drain
  uses: jonathanong/auto-harness/actions/dispatch@512d03c89dd3511a0d1f644692767371f9a04ce2
  with:
    operation: start-drain
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    idempotency-key: deploy-${{ github.run_id }}

- name: Wait for terminal proof
  id: drain-status
  uses: jonathanong/auto-harness/actions/dispatch@512d03c89dd3511a0d1f644692767371f9a04ce2
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
  uses: jonathanong/auto-harness/actions/dispatch@512d03c89dd3511a0d1f644692767371f9a04ce2
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
