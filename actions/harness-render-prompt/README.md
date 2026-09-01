# Render Codex prompt

Renders a Codex prompt template through the bundled `render-harness-prompt.mts` script and
emits the result as a multiline `prompt` output, wrapped with a fixed CI-session preamble and
a merge-authority postlude. The companion script ships inside this action's own directory
(invoked via `${{ github.action_path }}`), so a consumer needs no script setup of its own —
only the template.

Replace `<sha>` below with a reviewed full commit SHA from `main`, then deliberately update it
when adopting a newer revision. Do not use the moving `main` ref.

```yaml
- name: Render the dispatch prompt
  id: prompt
  uses: jonathanong/auto-harness/actions/harness-render-prompt@<sha>
  with:
    template: docs/prompts/automation/fix-main.md
    vars: |
      PR_NUMBER=${{ github.event.pull_request.number }}
    var-files: |
      FAILURE_LOG=/tmp/failure.log
```

## Requirements

- The template must live at a path under `docs/prompts/automation/` in the **calling**
  repository's own checkout — the script resolves `--template` relative to `process.cwd()`,
  which a composite action `run:` step executes at the calling repo's checkout root.
- The caller must run its own Node setup step (node v22.18+, `node_modules` installed) before
  invoking this action.
- This action requires the calling repository to have
  [`vouchington-tooling`](https://www.npmjs.com/package/vouchington-tooling) installed as a
  dependency (available under `$GITHUB_WORKSPACE/node_modules`) before it runs — it resolves
  `vouchington-tooling`'s bundled `scripts/gha/write-github-multiline-output.sh` helper via
  Node module resolution rather than shipping its own copy.
- The rendered prompt's CI merge-authority postlude states the policy generically. It does not
  point at any repo-specific policy document — consumers that want a longer-form merge
  authority doc of their own should keep one and link to it from wherever their agents read
  repository instructions.
