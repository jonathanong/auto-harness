# Git Hooks

`pre-push` is the only hook here. It exists because `pnpm fmt:check` broke CI twice in one
session when a changed-files-only check was run by hand instead — `oxfmt` also formats
Markdown, YAML, and TOML, not just TypeScript, so a partial check misses real violations. This
repo diverges here from the sibling `vouchington` repo's `.husky/CLAUDE.md`, which documents "no
pre-push hook" in favor of a before-pushing checklist: the checklist approach was tried in this
repo first and it failed (the same bug shipped twice), so the check is enforced mechanically
instead.

GitHub Actions is still the full, authoritative gate. `pre-push` is a faster local backstop that
reuses the same root `package.json` scripts CI runs (`fmt:check`, `lint`) instead of re-spelling
tool invocations, so it cannot silently drift from CI.

## Invariants

- `pre-push` must exit `0` immediately when `GITHUB_ACTIONS=true`, before running anything else.
  CI runs its own steps for these same checks and must never re-run them through the hook.
- Every check reuses a root `package.json` script (`pnpm run fmt:check`, `pnpm run lint`) instead
  of re-spelling the underlying tool invocation.
- Never bypass a failing hook with `--no-verify`, `HUSKY=0`, or `core.hooksPath`. Fix the failure
  the hook reports.
- Do not add a pre-commit hook or any other hook here without updating this file and
  `scripts/pre-push-hook.test.ts` together.

## Edge cases in the "branch is up to date with `main`" check

- **On `main` itself:** skipped — there is nothing to be "ahead of".
- **A brand-new branch:** not special-cased. It is simply checked like any other branch; a new
  branch cut from a current `main` passes trivially.
- **`origin` unreachable (offline):** `git fetch` failing does not block the push. Network access
  is not guaranteed for every push, and this check runs again on the next push.
- **`pnpm` missing from `PATH`:** the hook fails loudly and stops before running any check,
  rather than silently skipping formatting/lint. A `pre-push` hook that can silently no-op
  defeats its own purpose.

## Setup

`husky`'s `prepare` script (`"prepare": "husky"`) sets `core.hooksPath` to `.husky/_` the first
time `pnpm install` runs. That value lands in the **shared** repo config
(`<main-checkout>/.git/config`) because this repo does not set `extensions.worktreeConfig` — one
`pnpm install`, from any worktree, enables the hook for every worktree of the same clone. Each
worktree still needs its own `pnpm install` to generate its own `.husky/_/` trampoline files
(gitignored, not committed) before the hook actually runs there; until then, git silently skips
the missing hook file, so other worktrees on branches without `.husky/` are unaffected.
