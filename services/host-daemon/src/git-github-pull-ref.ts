import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { createChildEnv } from "./child-env.ts";
import type { ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";
import type { GitHubPullRefConfig } from "./github-pull-ref-config.ts";

const GITHUB_PULL_REQUEST_REF = /^refs\/pull\/([1-9]\d*)\/head$/;

export type GitHubPullRequestFetch = Readonly<{
  ref: string;
  sha: string;
}>;

export function isGitHubPullRequestRef(ref: string): boolean {
  return GITHUB_PULL_REQUEST_REF.test(ref);
}

export function nullGlobalGitConfigPath(platformName: NodeJS.Platform = platform()): string {
  return platformName === "win32" ? "NUL" : "/dev/null";
}

function isolatedFetchEnvironment(objectDirectory: string | undefined): NodeJS.ProcessEnv {
  // Do not let system or user configuration rewrite the daemon-pinned URL. The temporary bare
  // repository below is new for this operation, so it has no repository-local URL rewrites either.
  return {
    ...createChildEnv(),
    // A platform null device cannot be planted by a concurrent session, unlike a config file in
    // the same-UID temporary directory used for the isolated bare repository.
    GIT_CONFIG_GLOBAL: nullGlobalGitConfigPath(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...(objectDirectory === undefined ? {} : { GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory }),
  };
}

function transportArguments(config: GitHubPullRefConfig): string[] {
  const { transport } = config;
  return [
    ...(transport.credentialHelper === undefined
      ? []
      : ["-c", `credential.helper=${transport.credentialHelper}`]),
    ...(transport.httpProxy === undefined ? [] : ["-c", `http.proxy=${transport.httpProxy}`]),
    ...(transport.sslCAInfo === undefined ? [] : ["-c", `http.sslCAInfo=${transport.sslCAInfo}`]),
  ];
}

function normalizedConfig(
  value: GitHubPullRefConfig | string | undefined,
): GitHubPullRefConfig | undefined {
  if (typeof value === "string") return { remoteUrl: value, transport: {} };
  return value;
}

function advertisedPullRequestHead(output: string, ref: string): string | undefined {
  const [line, ...additionalLines] = output
    .split(/\r?\n/)
    .filter((candidate) => candidate.length > 0);
  if (line === undefined || additionalLines.length > 0) return undefined;
  const [sha, advertisedRef, ...rest] = line.split("\t");
  if (
    rest.length > 0 ||
    advertisedRef !== ref ||
    sha === undefined ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)
  ) {
    return undefined;
  }
  return sha;
}

export async function fetchGitHubPullRequestRef(
  runner: ProcessRunner,
  cwd: string,
  ref: string,
  config: GitHubPullRefConfig | string | undefined,
  objectDirectory?: string,
  baseCommit?: string,
  signal?: AbortSignal,
): Promise<GitHubPullRequestFetch | null> {
  const configured = normalizedConfig(config);
  if (!isGitHubPullRequestRef(ref) || !configured) return null;
  // The URL and narrowly scoped transport options are loaded from an operator-owned file, never
  // mutable repository, global, or system Git configuration.
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
  const environment = isolatedFetchEnvironment(objectDirectory);
  const transport = transportArguments(configured);
  try {
    // Capture the exact remote-advertised object identity before a same-UID session can mutate
    // the temporary repository's loose ref. Git object IDs bind the subsequently imported commit
    // cryptographically; a tampered ref can now only turn this transfer into a failed checkout.
    const advertised = await runGit(
      runner,
      temporaryDirectory,
      [...transport, "ls-remote", "--exit-code", configured.remoteUrl, ref],
      signal,
      environment,
    );
    if (advertised.exitCode !== 0) return null;
    const advertisedSha = advertisedPullRequestHead(advertised.stdout, ref);
    if (advertisedSha === undefined) return null;
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
        ...transport,
        "--git-dir",
        temporaryRepository,
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        configured.remoteUrl,
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
    if (sha !== advertisedSha) return null;
    // When the requested pull head is already reachable from the current checkout, `bundle
    // create fetchedRef ^baseCommit` correctly refuses to create an empty bundle. The object is
    // already present through the alternate object directory, so root it directly instead.
    const excludesPresentBase = objectDirectory !== undefined && baseCommit !== undefined;
    if (excludesPresentBase) {
      const alreadyPresent = await runGit(
        runner,
        temporaryDirectory,
        ["--git-dir", temporaryRepository, "merge-base", "--is-ancestor", sha, baseCommit],
        signal,
        environment,
      );
      if (alreadyPresent.exitCode === 0) {
        const recorded = await runGit(
          runner,
          cwd,
          ["update-ref", "--no-deref", destination, sha],
          signal,
          { ...createChildEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
        );
        return recorded.exitCode === 0 ? { ref: destination, sha } : null;
      }
      if (alreadyPresent.exitCode !== 1) return null;
    }
    const bundled = await runGit(
      runner,
      temporaryDirectory,
      [
        "--git-dir",
        temporaryRepository,
        "bundle",
        "create",
        bundlePath,
        // Git bundles require a named ref for their header. Including the advertised SHA as a
        // second positive rev-list argument keeps that exact object in the pack even if a
        // same-UID session replaces the temporary named ref after the comparison above.
        fetchedRef,
        sha,
        ...(excludesPresentBase ? [`^${baseCommit}`] : []),
      ],
      signal,
      environment,
    );
    if (bundled.exitCode !== 0) return null;
    const imported = await runGit(runner, cwd, ["bundle", "unbundle", bundlePath], signal, {
      ...createChildEnv(),
      GIT_NO_REPLACE_OBJECTS: "1",
    });
    if (imported.exitCode !== 0) return null;
    const recorded = await runGit(
      runner,
      cwd,
      ["update-ref", "--no-deref", destination, sha],
      signal,
      { ...createChildEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
    );
    return recorded.exitCode === 0 ? { ref: destination, sha } : null;
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
    { ...createChildEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
  );
  if (cleaned.exitCode !== 0) {
    throw new Error(`Failed to clean up GitHub pull-request ref ${sourceRef}`);
  }
}
