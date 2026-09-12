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
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isGitHubPullRequestRef(ref)) return null;
  // `origin` is the operator-configured repository remote. Do not probe mutable extra remotes:
  // a prior attacker-influenced session can add one and make it serve an unrelated PR ref.
  // One scratch ref per claimed worktree bounds crash leftovers independently of PR volume.
  const digest = createHash("sha256").update(cwd).digest("hex");
  const destination = `refs/auto-harness/pull-fetch/${digest}`;
  const fetched = await runGit(
    runner,
    cwd,
    ["fetch", "--no-write-fetch-head", "--no-tags", "origin", `+${ref}:${destination}`],
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
  const cleaned = await runGit(runner, cwd, ["update-ref", "-d", destination], signal);
  if (cleaned.exitCode !== 0) {
    throw new Error(`Failed to clean up GitHub pull-request ref ${sourceRef}`);
  }
}
