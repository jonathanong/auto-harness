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
- The up-to-date check reads the refs git supplies on **stdin**, never the checked-out branch.
  See the edge cases below for why.
- Do not add a pre-commit hook or any other hook here without updating this file and
  `scripts/pre-push-hook.test.ts` together.

## Edge cases in the "pushed branches are up to date with `main`" check

Git feeds `pre-push` one line per pushed ref on stdin:

```
<local ref> SP <local sha> SP <remote ref> SP <remote sha>
```

The hook reads those lines rather than `git rev-parse --abbrev-ref HEAD`, because **the
checked-out branch is not the pushed ref**. Reading the branch instead produced two silent
no-ops: `git push origin feature` from a `main` checkout skipped the check entirely, and
`git push origin main` from a feature checkout compared the wrong commit. The lines are read
before `fmt:check`/`lint` run, so git is never left blocked writing into a pipe nobody drains
when an early check fails during a push with a long ref list.

- **A pushed ref of `refs/heads/main`:** skipped — `main` is the baseline and cannot be behind
  itself. A push carrying only `main` reaches no `git` invocation at all.
- **A branch deletion:** skipped. Git reports an all-zero local sha, so there is no commit to
  compare. Matched as "all zeros" rather than a 40-zero literal, so sha256 repositories work.
- **Several refs in one push:** every non-`main` ref is checked, and the failure message names
  the ref that is behind. Stopping at the first ref would let a stale second branch through.
- **A brand-new branch:** not special-cased. It is simply checked like any other pushed ref; a
  new branch cut from a current `main` passes trivially.
- **`origin` unreachable (offline):** `git fetch origin main` failing does not block the push.
  Network access is not guaranteed for every push, and this check runs again on the next push.
- **Comparing against `FETCH_HEAD`, not `refs/remotes/origin/main`:** the fetch above always
  writes `FETCH_HEAD`, while updating the remote-tracking ref is an opportunistic side effect of
  the remote's configured refspec. A narrowed refspec leaves `origin/main` stale or absent, which
  would compare against the wrong commit or skip the check.
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
