import { createHash } from "node:crypto";

import type { ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";

const GITHUB_PULL_REQUEST_REF = /^refs\/pull\/([1-9]\d*)\/head$/;

export function isGitHubPullRequestRef(ref: string): boolean {
  return GITHUB_PULL_REQUEST_REF.test(ref);
}

export async function fetchGitHubPullRequestRef(
  runner: ProcessRunner,
  cwd: string,
  ref: string,
  remoteUrl: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isGitHubPullRequestRef(ref) || !remoteUrl) return null;
  // The URL was captured from `origin` before any untrusted session ran and is kept in the
  // daemon's memory for the repository lifetime. Do not re-read mutable repository config here.
  // One scratch ref per claimed worktree bounds crash leftovers independently of PR volume.
  const digest = createHash("sha256").update(cwd).digest("hex");
  const destination = `refs/auto-harness/pull-fetch/${digest}`;
  const symbolic = await runGit(
    runner,
    cwd,
    ["symbolic-ref", "--quiet", "--", destination],
    signal,
  );
  if (symbolic.exitCode === 0) {
    throw new Error(`Refusing symbolic GitHub pull-request scratch ref ${destination}`);
  }
  if (symbolic.exitCode !== 1) {
    throw new Error(`Failed to inspect GitHub pull-request scratch ref ${destination}`);
  }
  const fetched = await runGit(
    runner,
    cwd,
    ["fetch", "--no-write-fetch-head", "--no-tags", remoteUrl, `+${ref}:${destination}`],
    signal,
  );
  return fetched.exitCode === 0 ? destination : null;
}

export async function deleteGitHubPullRequestRef(
  runner: ProcessRunner,
  cwd: string,
  destination: string,
  sourceRef: string,
  signal?: AbortSignal,
): Promise<void> {
  const cleaned = await runGit(
    runner,
    cwd,
    ["update-ref", "--no-deref", "-d", destination],
    signal,
  );
  if (cleaned.exitCode !== 0) {
    throw new Error(`Failed to clean up GitHub pull-request ref ${sourceRef}`);
  }
}
