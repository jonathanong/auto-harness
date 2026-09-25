import type { ProcessRunner } from "./executor.ts";
import { checkoutFetchFailure, gitFailure, listConfiguredRemotes, runGit } from "./git-commands.ts";

/** A full SHA-1 or SHA-256 commit id; the only ref form resolved without fetching first. */
export const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * A plain branch-like name that can be appended to `refs/remotes/<remote>/` without
 * becoming revision syntax (`~`, `^`, `:`, `@{`, `..`) or naming a remote's symbolic `HEAD`.
 */
function isRemoteBranchCandidate(ref: string): boolean {
  return (
    ref !== "HEAD" &&
    !ref.startsWith("refs/") &&
    !ref.startsWith("-") &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !/[\s~^:?*[\\]/.test(ref)
  );
}

function resolveCommit(runner: ProcessRunner, cwd: string, rev: string, signal?: AbortSignal) {
  return runGit(
    runner,
    cwd,
    ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`],
    signal,
  );
}

async function fetchAll(runner: ProcessRunner, cwd: string, ref: string, signal?: AbortSignal) {
  try {
    return await runGit(runner, cwd, ["fetch", "--all", "--tags"], signal);
  } catch (error) {
    throw checkoutFetchFailure(
      `Failed to fetch ref ${ref}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function resolveRemoteTip(
  runner: ProcessRunner,
  cwd: string,
  ref: string,
  signal?: AbortSignal,
): Promise<{ sha: string; source: string } | undefined> {
  if (!isRemoteBranchCandidate(ref)) return undefined;
  const remotes = await listConfiguredRemotes(runner, cwd, signal);
  // `git remote` lists alphabetically; the conventional clone remote wins ties.
  const ordered = [
    ...remotes.filter((remote) => remote === "origin"),
    ...remotes.filter((remote) => remote !== "origin"),
  ];
  for (const remote of ordered) {
    const source = `refs/remotes/${remote}/${ref}`;
    const resolved = await resolveCommit(runner, cwd, source, signal);
    if (resolved.exitCode === 0) return { sha: resolved.stdout.trim(), source };
  }
  return undefined;
}

/**
 * Resolve an ordinary (non pull-request) session ref to the commit to check out.
 *
 * - A full commit SHA keeps the no-fetch fast path: it resolves locally and fetches
 *   only when the object is missing.
 * - Any other ref (branch, tag, short SHA) fetches every remote first, then prefers
 *   the freshly fetched remote-tracking branch `refs/remotes/<remote>/<ref>` (origin
 *   first) over a same-named local branch, which in a pool checkout is usually stale.
 *   Without a matching remote-tracking branch it falls back to `<ref>` itself.
 * - A nonzero fetch is tolerated when the ref still resolves (possibly stale), and
 *   reported through `onWarning`; it fails as a checkout fetch failure only when
 *   nothing resolves. A fetch that throws always fails as a checkout fetch failure.
 */
export async function resolveCheckoutRef(
  runner: ProcessRunner,
  cwd: string,
  ref: string,
  signal?: AbortSignal,
  onWarning?: (message: string) => void,
): Promise<string> {
  if (FULL_COMMIT_ID.test(ref)) {
    let resolved = await resolveCommit(runner, cwd, ref, signal);
    if (resolved.exitCode !== 0) {
      const fetched = await fetchAll(runner, cwd, ref, signal);
      resolved = await resolveCommit(runner, cwd, ref, signal);
      if (fetched.exitCode !== 0 && resolved.exitCode !== 0) {
        throw checkoutFetchFailure(`Failed to fetch ref ${ref}`, fetched.stderr);
      }
    }
    if (resolved.exitCode !== 0) {
      throw gitFailure(`Failed to resolve ref ${ref}`, resolved.stderr);
    }
    return resolved.stdout.trim();
  }
  const fetched = await fetchAll(runner, cwd, ref, signal);
  const remoteTip = await resolveRemoteTip(runner, cwd, ref, signal);
  let sha = remoteTip?.sha;
  if (sha === undefined) {
    const resolved = await resolveCommit(runner, cwd, ref, signal);
    if (resolved.exitCode !== 0) {
      if (fetched.exitCode !== 0) {
        throw checkoutFetchFailure(`Failed to fetch ref ${ref}`, fetched.stderr);
      }
      throw gitFailure(`Failed to resolve ref ${ref}`, resolved.stderr);
    }
    sha = resolved.stdout.trim();
  }
  if (fetched.exitCode !== 0) {
    const source = remoteTip?.source ?? ref;
    onWarning?.(
      gitFailure(
        `Warning: fetch failed before resolving ref ${ref}; using possibly stale ${source} at ${sha}`,
        fetched.stderr,
      ).message,
    );
  }
  return sha;
}
