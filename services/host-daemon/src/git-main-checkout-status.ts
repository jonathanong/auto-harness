import { resolve } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";
import { canonicalPath, listedWorktreePaths } from "./git-worktree-paths.ts";

export type MainCheckoutDirtyEntry = { code: string; path: string };

/**
 * Parse `git status --porcelain -z --untracked-files=all` output. `-z` avoids
 * core.quotepath C-escaping any non-ASCII path (which would otherwise defeat
 * the worktree-path comparison in `mainCheckoutDirtyEntries`), and
 * `--untracked-files=all` stops git from collapsing an untracked directory
 * into a single line *unless* that directory is itself a linked-worktree
 * boundary -- exactly the signal needed to tell "the daemon's own worktree"
 * apart from an operator's untracked directory.
 */
function parseStatusZ(stdout: string): MainCheckoutDirtyEntry[] {
  const raw = stdout.endsWith("\0") ? stdout.slice(0, -1) : stdout;
  const parts = raw.length > 0 ? raw.split("\0") : [];
  const entries: MainCheckoutDirtyEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const code = part.slice(0, 2);
    entries.push({ code, path: part.slice(3) });
    // A rename/copy entry carries its origin path as a second NUL-terminated
    // field with no status prefix; skip it so it is not misread as its own entry.
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return entries;
}

/**
 * Main checkouts refuse to switch branch while dirty (see `prepareMainCheckout`
 * in git.ts). The daemon's own `git worktree add --detach <configured path>`
 * can be the sole cause of that dirt when an operator points a worktree path
 * inside the repository. `git switch` never writes into a linked worktree's
 * directory, so a directory git itself already recognizes as a registered
 * linked worktree of this repo poses no risk to disregard here -- it is
 * self-inflicted daemon state, not uncommitted operator work. A genuine
 * tracked modification, or any untracked path that is *not* a registered
 * worktree, still fails the guard below.
 */
export async function mainCheckoutDirtyEntries(
  runner: ProcessRunner,
  cwd: string,
  statusStdout: string,
  signal?: AbortSignal,
): Promise<MainCheckoutDirtyEntry[]> {
  const entries = parseStatusZ(statusStdout);
  if (entries.length === 0 || !entries.some((entry) => entry.code === "??")) {
    return entries;
  }
  const listed = await runGit(runner, cwd, ["worktree", "list", "--porcelain"], signal);
  // Fail closed: if the worktree list itself cannot be read, disregard nothing.
  const ownWorktrees =
    listed.exitCode === 0 ? await listedWorktreePaths(listed.stdout, cwd) : new Set<string>();
  const remaining: MainCheckoutDirtyEntry[] = [];
  for (const entry of entries) {
    if (entry.code === "??") {
      const trimmed = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
      if (ownWorktrees.has(await canonicalPath(resolve(cwd, trimmed)))) {
        continue;
      }
    }
    remaining.push(entry);
  }
  return remaining;
}
