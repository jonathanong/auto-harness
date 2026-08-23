# Auto Harness dispatch action

```yaml
- uses: jonathanong/auto-harness/actions/dispatch@main
  with:
    server-url: ${{ secrets.AUTO_HARNESS_URL }}
    api-key: ${{ secrets.AUTO_HARNESS_API_KEY }}
    repository-id: repo-1
    prompt: Review this pull request
    target: '{"providerId":"codex"}'
    concurrency-id: github-${{ github.run_id }}
```

The action returns as soon as the session is accepted. Use the `session-id`, `session-url`, and
`created` outputs for annotations or later automation.
