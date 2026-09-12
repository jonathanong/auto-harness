import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChildEnv } from "./child-env.ts";
import type { ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";

const GITHUB_PULL_REQUEST_REF = /^refs\/pull\/([1-9]\d*)\/head$/;

export function isGitHubPullRequestRef(ref: string): boolean {
  return GITHUB_PULL_REQUEST_REF.test(ref);
}

function isolatedFetchEnvironment(configDirectory: string): NodeJS.ProcessEnv {
  // Do not let system or user configuration rewrite the daemon-pinned URL. The temporary bare
  // repository below is new for this operation, so it has no repository-local URL rewrites either.
  return {
    ...createChildEnv(),
    GIT_CONFIG_GLOBAL: join(configDirectory, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
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
  // Fetch it in a fresh bare repository with URL-rewrite configuration disabled, then import a
  // bundle. This prevents a prior session's common-config `url.*.insteadOf` setting from changing
  // the pinned transport endpoint.
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "auto-harness-pull-fetch-"));
  const temporaryRepository = join(temporaryDirectory, "repository.git");
  const bundlePath = join(temporaryDirectory, "pull.bundle");
  const fetchedRef = "refs/auto-harness/pull-fetch/source";
  // `refs/worktree` is private to this linked worktree. A fresh random component also prevents a
  // prior session in the same worktree from precreating the handoff ref.
  const destination = `refs/worktree/auto-harness/pull-fetch/${randomUUID()}`;
  const environment = isolatedFetchEnvironment(temporaryDirectory);
  try {
    const initialized = await runGit(
      runner,
      temporaryDirectory,
      ["init", "--bare", temporaryRepository],
      signal,
      environment,
    );
    if (initialized.exitCode !== 0) return null;
    const fetched = await runGit(
      runner,
      temporaryDirectory,
      [
        "--git-dir",
        temporaryRepository,
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        remoteUrl,
        `+${ref}:${fetchedRef}`,
      ],
      signal,
      environment,
    );
    if (fetched.exitCode !== 0) return null;
    const resolved = await runGit(
      runner,
      temporaryDirectory,
      ["--git-dir", temporaryRepository, "rev-parse", "--verify", `${fetchedRef}^{commit}`],
      signal,
      environment,
    );
    if (resolved.exitCode !== 0) return null;
    const sha = resolved.stdout.trim();
    if (sha.length === 0) return null;
    const bundled = await runGit(
      runner,
      temporaryDirectory,
      ["--git-dir", temporaryRepository, "bundle", "create", bundlePath, fetchedRef],
      signal,
      environment,
    );
    if (bundled.exitCode !== 0) return null;
    const imported = await runGit(runner, cwd, ["bundle", "unbundle", bundlePath], signal);
    if (imported.exitCode !== 0) return null;
    const recorded = await runGit(
      runner,
      cwd,
      ["update-ref", "--no-deref", destination, sha],
      signal,
    );
    return recorded.exitCode === 0 ? destination : null;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
