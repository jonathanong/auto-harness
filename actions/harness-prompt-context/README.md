# Auto Harness prompt context

Dedup for Auto Harness dispatch normally lives on the `concurrency-id` passed to
[`actions/dispatch`](../dispatch/README.md): re-POSTing the same id while a session is
queued/running returns the existing session instead of creating a second one. This action
covers what that primitive cannot handle.

In its default `related-candidates` mode, it emits non-gating JSON of related open PRs/issues
for the dispatch prompt, so the dispatched agent can find and update same-topic items itself
instead of opening a duplicate. In `pr-commits` mode, it checks whether a known PR already
received a non-bot commit — the loop-breaker a Dependabot re-dispatch needs, since each retry
mints a fresh head-sha concurrency id that the dispatch action's own dedup can't see across.

Replace `<sha>` below with a reviewed full commit SHA from `main`, then deliberately update it
when adopting a newer revision. Do not use the moving `main` ref.

```yaml
permissions:
  pull-requests: read
  issues: read

steps:
  - name: Gather related-candidates context
    id: prompt-context
    uses: jonathanong/auto-harness/actions/harness-prompt-context@<sha>
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      related-title-key: "flaky test"
      related-extra-labels: automation
```

```yaml
permissions:
  pull-requests: read

steps:
  - name: Check for a prior automated fix on this PR
    id: dedup
    uses: jonathanong/auto-harness/actions/harness-prompt-context@<sha>
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      search-mode: pr-commits
      topic-key: ${{ github.event.pull_request.number }}
```

## Requirements

This action requires the calling repository to have
[`vouchington-tooling`](https://www.npmjs.com/package/vouchington-tooling) installed as a
dependency (available under `$GITHUB_WORKSPACE/node_modules`) before it runs — it resolves
`vouchington-tooling`'s bundled `scripts/gha/write-github-multiline-output.sh` helper via Node
module resolution rather than shipping its own copy. That helper shells out to `uuidgen` to mint
its output delimiter, so the runner needs `uuidgen` on `PATH` as well — present by default on
GitHub-hosted `ubuntu-*`/`macos-*`/`windows-*` runners; a minimal or self-hosted runner must
install it separately.

## Permissions

The `github-token` needs `pull-requests: read` for both modes (`gh pr view`, `gh pr list`, and
the `pr-commits` mode's commit-author check). Add `issues: read` as well when
`check-issues: true` (the default) enables the issue half of `related-candidates` mode. A token
scoped narrower than this fails the underlying `gh` calls open rather than closed — they warn
and return an empty/no-match result — so an under-scoped token silently disables the action's
dedup behavior instead of erroring.
