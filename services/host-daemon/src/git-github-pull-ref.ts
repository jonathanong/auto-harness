/* eslint-disable max-lines -- advertisement, identity verification, and bundle import form one security boundary. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join, parse } from "node:path";

import { createChildEnv } from "./child-env.ts";
import type { ProcessRunner } from "./executor.ts";
import { checkoutFetchFailure, runGit } from "./git-commands.ts";
import { clearTrackedPathFlags } from "./git-worktree-reset.ts";
import type { GitHubPullRefConfig } from "./github-pull-ref-config.ts";

const GITHUB_PULL_REQUEST_REF = /^refs\/pull\/([1-9]\d*)\/head$/;

export type GitHubPullRequestFetch = Readonly<{
  ref: string;
  sha: string;
}>;

export type GitObjectFormat = "sha1" | "sha256";

export function isGitHubPullRequestRef(ref: string): boolean {
  return GITHUB_PULL_REQUEST_REF.test(ref);
}

export function nullGlobalGitConfigPath(platformName: NodeJS.Platform = platform()): string {
  return platformName === "win32" ? "NUL" : "/dev/null";
}

export function gitObjectFormat(value: string): GitObjectFormat | undefined {
  return value === "sha1" || value === "sha256" ? value : undefined;
}

function isolatedFetchEnvironment(objectDirectory: string | undefined): NodeJS.ProcessEnv {
  // Do not let system, user, or scratch-repository settings run hooks or supply ambient transport
  // credentials. The advertised SHA remains the immutable identity boundary if a same-UID session
  // tampers with other mutable scratch-repository configuration between subprocesses.
  return {
    ...createChildEnv(),
    // A platform null device cannot be planted by a concurrent session, unlike a config file in
    // the same-UID temporary directory used for the isolated bare repository.
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_GLOBAL: nullGlobalGitConfigPath(),
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_KEY_2: "http.proxy",
    // fsmonitor is an independent command-execution mechanism. Disable it for every pull-ref
    // command, including configuration/identity probes that run before materialization.
    GIT_CONFIG_KEY_3: "core.fsmonitor",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_VALUE_0: nullGlobalGitConfigPath(),
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_VALUE_3: "false",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...(objectDirectory === undefined
      ? {}
      : { GIT_ALTERNATE_OBJECT_DIRECTORIES: gitAlternateObjectDirectory(objectDirectory) }),
  };
}

function gitAlternateObjectDirectory(path: string): string {
  // Git separates alternate directories with `:` on POSIX. Its documented C-style quoting keeps
  // a literal colon in one pathname instead of treating it as a second alternate directory.
  if (!path.includes(":")) return path;
  return `"${path
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function objectIdPattern(objectFormat: GitObjectFormat): RegExp {
  return objectFormat === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
}

function scratchRefEnvironment(): NodeJS.ProcessEnv {
  return {
    ...createChildEnv(),
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: nullGlobalGitConfigPath(),
    GIT_CONFIG_VALUE_1: "false",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function isolatedMaterializationEnvironment(
  trustedGitDirectory: string,
  cwd: string,
  objectDirectory: string,
  indexPath: string,
): NodeJS.ProcessEnv {
  return {
    ...isolatedFetchEnvironment(objectDirectory),
    // The policy loader accepts only an immutable administrator-owned bare repository here. A
    // target-tree attribute can name a filter, but its driver has no session-configured definition.
    // The exact object and real index are explicit operands, not discovered through the
    // session-controlled checkout.
    GIT_DIR: trustedGitDirectory,
    GIT_WORK_TREE: cwd,
    GIT_INDEX_FILE: indexPath,
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_4: "core.sparseCheckout",
    GIT_CONFIG_KEY_5: "core.bare",
    GIT_CONFIG_VALUE_4: "false",
    GIT_CONFIG_VALUE_5: "false",
  };
}

function transportArguments(config: GitHubPullRefFetchConfig): string[] {
  const { transport } = config;
  return [
    ...(transport.credentialHelper === undefined
      ? []
      : ["-c", `credential.helper=${transport.credentialHelper}`]),
    ...(transport.httpProxy === undefined ? [] : ["-c", `http.proxy=${transport.httpProxy}`]),
    ...(transport.sslCAInfo === undefined ? [] : ["-c", `http.sslCAInfo=${transport.sslCAInfo}`]),
  ];
}

type GitHubPullRefFetchConfig = Pick<GitHubPullRefConfig, "remoteUrl" | "transport">;

function normalizedConfig(
  value: GitHubPullRefConfig | string | undefined,
): GitHubPullRefFetchConfig | undefined {
  if (typeof value === "string") return { remoteUrl: value, transport: {} };
  return value;
}

function advertisedPullRequestBase(
  output: string,
  ref: string,
  objectFormat: GitObjectFormat,
): Readonly<{ base: string; head: string }> | undefined {
  const advertised = new Map<string, string>();
  for (const line of output.split(/\r?\n/).filter((candidate) => candidate.length > 0)) {
    const [sha, advertisedRef, ...rest] = line.split("\t");
    if (
      rest.length > 0 ||
      sha === undefined ||
      (advertisedRef !== ref && advertisedRef !== "HEAD") ||
      !objectIdPattern(objectFormat).test(sha) ||
      advertised.has(advertisedRef)
    ) {
      return undefined;
    }
    advertised.set(advertisedRef, sha);
  }
  const head = advertised.get(ref);
  const base = advertised.get("HEAD");
  return head === undefined || base === undefined ? undefined : { base, head };
}

async function cleanupTemporaryDirectory(
  runner: ProcessRunner,
  cwd: string,
  temporaryDirectory: string,
  destination: string,
  sourceRef: string,
  scratchRefCreated: boolean,
): Promise<void> {
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    if (scratchRefCreated) {
      // A failed temporary-directory cleanup must not leave the successfully created handoff
      // ref behind. Do not reuse the session signal: it may already be aborted, and cleanup
      // must remain independently bounded. Preserve the directory-removal error for callers.
      try {
        await deleteGitHubPullRequestRef(
          runner,
          cwd,
          destination,
          sourceRef,
          AbortSignal.timeout(10_000),
        );
      } catch {
        // Preserve the original temporary-directory failure; the scratch-ref cleanup was a
        // best-effort containment step because the caller never receives the handoff ref.
      }
    }
    throw error;
  }
}

async function runPullRequestTransport(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
  environment: NodeJS.ProcessEnv,
  category: string,
): Promise<Awaited<ReturnType<typeof runGit>>> {
  let result: Awaited<ReturnType<typeof runGit>>;
  try {
    result = await runGit(runner, cwd, args, signal, environment);
  } catch (error) {
    throw checkoutFetchFailure(category, error instanceof Error ? error.message : String(error));
  }
  if (result.exitCode !== 0) throw checkoutFetchFailure(category, result.stderr);
  return result;
}

export async function fetchGitHubPullRequestRef(
  runner: ProcessRunner,
  cwd: string,
  ref: string,
  config: GitHubPullRefConfig | string | undefined,
  objectDirectory: string | undefined,
  signal?: AbortSignal,
  objectFormat: GitObjectFormat = "sha1",
): Promise<GitHubPullRequestFetch | null> {
  const configured = normalizedConfig(config);
  if (!isGitHubPullRequestRef(ref) || !configured || objectDirectory === undefined) return null;
  // A shallow checkout cannot prove that the remote default branch is a complete reusable base.
  // This query is bounded and uses the claimed linked-worktree path only; a concurrent session can
  // turn it into a failure, but cannot select the negotiation tip.
  const shallow = await runGit(
    runner,
    cwd,
    ["rev-parse", "--is-shallow-repository"],
    signal,
    isolatedFetchEnvironment(undefined),
  );
  if (shallow.exitCode !== 0 || shallow.stdout.trim() !== "false") return null;
  // A promisor is a promise to lazily consult a repository-configured remote for missing objects.
  // Pull-ref checkout never allows that mutable configuration boundary, so reject it before
  // transfer. A concurrent session can remove this marker only into a later object failure.
  const partial = await runGit(
    runner,
    cwd,
    ["config", "--local", "--get", "extensions.partialClone"],
    signal,
    isolatedFetchEnvironment(undefined),
  );
  if (partial.exitCode !== 1) return null;
  const promisor = await runGit(
    runner,
    cwd,
    ["config", "--local", "--get-regexp", "^remote\\..*\\.promisor$"],
    signal,
    isolatedFetchEnvironment(undefined),
  );
  if (promisor.exitCode !== 1) return null;
  // The URL and narrowly scoped transport options are loaded from an operator-owned file, never
  // mutable repository, global, or system Git configuration.
  // Fetch it in a fresh bare repository with URL-rewrite configuration disabled, then import a
  // bundle. This prevents a prior session's common-config `url.*.insteadOf` setting from changing
  // the pinned transport endpoint.
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "auto-harness-pull-fetch-"));
  const bundlePath = join(temporaryDirectory, "pull.bundle");
  const fetchedRef = "refs/auto-harness/pull-fetch/source";
  // `refs/worktree` is private to this linked worktree. A fresh random component also prevents a
  // prior session in the same worktree from precreating the handoff ref.
  const destination = `refs/worktree/auto-harness/pull-fetch/${randomUUID()}`;
  let scratchRefCreated = false;
  const environment = isolatedFetchEnvironment(objectDirectory);
  const transport = transportArguments(configured);
  try {
    // Never run a transport command from the same-UID temporary directory: another session could
    // place a .git/config there and make Git discover a local url.*.insteadOf rule. The filesystem
    // root is owned by the host administrator under the policy that enables pull refs; it cannot
    // be replaced by a session. The Windows policy loader rejects pull refs until it can prove an
    // equivalent native ACL boundary.
    const transportCwd = parse(temporaryDirectory).root;
    const fetchCategory = `Failed to fetch GitHub pull-request ref ${ref}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Capture the exact remote-advertised object identity before a same-UID session can mutate
      // the temporary repository's loose ref. Git object IDs bind the subsequently imported commit
      // cryptographically; a tampered ref can now only turn this transfer into a failed checkout.
      const advertised = await runPullRequestTransport(
        runner,
        transportCwd,
        [...transport, "ls-remote", "--exit-code", configured.remoteUrl, ref, "HEAD"],
        signal,
        environment,
        fetchCategory,
      );
      const advertisedRefs = advertisedPullRequestBase(advertised.stdout, ref, objectFormat);
      if (advertisedRefs === undefined) return null;
      const temporaryRepository = join(temporaryDirectory, `repository-${attempt}.git`);
      const initialized = await runGit(
        runner,
        transportCwd,
        ["init", "--bare", `--object-format=${objectFormat}`, temporaryRepository],
        signal,
        environment,
      );
      if (initialized.exitCode !== 0) return null;
      // A remote-advertised HEAD is outside a session's control. Probe it through the claimed
      // object store before negotiation, rather than using the worktree's mutable HEAD and risking
      // an unrelated session commit forcing a full-history transfer. This is deliberately an
      // object probe, not a repository-wide fsck: missing partial objects are fail-closed by the
      // negotiated fetch's prerequisite and the delta bundle import.
      const basePresent = await runGit(
        runner,
        transportCwd,
        ["--git-dir", temporaryRepository, "cat-file", "-e", `${advertisedRefs.base}^{commit}`],
        signal,
        environment,
      );
      if (basePresent.exitCode !== 0) return null;
      await runPullRequestTransport(
        runner,
        transportCwd,
        [
          ...transport,
          "--git-dir",
          temporaryRepository,
          "fetch",
          "--no-write-fetch-head",
          "--no-tags",
          `--negotiation-tip=${advertisedRefs.base}`,
          configured.remoteUrl,
          `+${ref}:${fetchedRef}`,
        ],
        signal,
        environment,
        fetchCategory,
      );
      const resolved = await runGit(
        runner,
        transportCwd,
        ["--git-dir", temporaryRepository, "rev-parse", "--verify", `${fetchedRef}^{commit}`],
        signal,
        environment,
      );
      if (resolved.exitCode !== 0) return null;
      const sha = resolved.stdout.trim();
      // A force-push can race the advertisement. Retry the whole immutable advertisement/fetch
      // pair once, then fail closed rather than accepting a different object identity.
      if (sha !== advertisedRefs.head) continue;
      // The configured remote's default branch can have diverged from a valid pull-request base.
      // Prove they share an ancestor, but retain the verified remote HEAD itself as the bundle
      // prerequisite: the claimed repository already has it, so Git need not duplicate objects
      // that are new on the default branch after that common ancestor.
      const commonBase = await runGit(
        runner,
        transportCwd,
        ["--git-dir", temporaryRepository, "merge-base", sha, advertisedRefs.base],
        signal,
        environment,
      );
      const base = commonBase.stdout.trim();
      if (commonBase.exitCode !== 0 || !objectIdPattern(objectFormat).test(base)) return null;
      // When the requested pull head is already reachable from the trusted remote base, creating
      // an empty bundle would fail. Root it directly; every object is already in the verified
      // alternate store.
      const alreadyPresent = await runGit(
        runner,
        transportCwd,
        ["--git-dir", temporaryRepository, "merge-base", "--is-ancestor", sha, advertisedRefs.base],
        signal,
        environment,
      );
      if (alreadyPresent.exitCode === 0) {
        const recorded = await runGit(
          runner,
          cwd,
          ["update-ref", "--no-deref", destination, sha],
          signal,
          scratchRefEnvironment(),
        );
        if (recorded.exitCode !== 0) return null;
        scratchRefCreated = true;
        return { ref: destination, sha };
      }
      if (alreadyPresent.exitCode !== 1) return null;
      const bundled = await runGit(
        runner,
        transportCwd,
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
          `^${advertisedRefs.base}`,
        ],
        signal,
        environment,
      );
      if (bundled.exitCode !== 0) return null;
      // This is the only transfer command that targets the claimed repository. It does not
      // materialize a tree, but it must still disable fsmonitor before Git opens its index.
      const imported = await runGit(
        runner,
        cwd,
        ["bundle", "unbundle", bundlePath],
        signal,
        isolatedFetchEnvironment(undefined),
      );
      if (imported.exitCode !== 0) return null;
      const recorded = await runGit(
        runner,
        cwd,
        ["update-ref", "--no-deref", destination, sha],
        signal,
        scratchRefEnvironment(),
      );
      if (recorded.exitCode !== 0) return null;
      scratchRefCreated = true;
      return { ref: destination, sha };
    }
    return null;
  } finally {
    await cleanupTemporaryDirectory(
      runner,
      cwd,
      temporaryDirectory,
      destination,
      ref,
      scratchRefCreated,
    );
  }
}

/**
 * Materialize a fetched pull head using a root-owned policy-provisioned bare Git
 * directory and the claimed worktree's real index. This deliberately never runs
 * checkout/reset porcelain against the shared repository configuration, which a
 * prior session can edit.
 */
export async function materializeGitHubPullRequestRef(
  runner: ProcessRunner,
  trustedGitDirectory: string,
  cwd: string,
  sha: string,
  objectDirectory: string,
  indexPath: string,
  objectFormat: GitObjectFormat,
  signal?: AbortSignal,
): Promise<boolean> {
  // `read-tree` needs only an object database, worktree, and index. The policy-provisioned bare
  // repository is root-owned and immutable to sessions, unlike a same-UID temporary repository.
  const trustedFormat = await runGit(
    runner,
    parse(trustedGitDirectory).root,
    ["--git-dir", trustedGitDirectory, "rev-parse", "--show-object-format=storage"],
    signal,
    isolatedFetchEnvironment(undefined),
  );
  if (
    trustedFormat.exitCode !== 0 ||
    gitObjectFormat(trustedFormat.stdout.trim()) !== objectFormat
  ) {
    return false;
  }
  // Isolated read-tree skips claimed-worktree recovery porcelain. Hidden index
  // flags still have to be cleared on the real index or Git can refuse to
  // replace a skip-worktree / assume-unchanged tracked path.
  const environment = isolatedMaterializationEnvironment(
    trustedGitDirectory,
    cwd,
    objectDirectory,
    indexPath,
  );
  await clearTrackedPathFlags(runner, cwd, signal, environment);
  const materialized = await runGit(
    runner,
    cwd,
    ["read-tree", "--reset", "-u", "--no-sparse-checkout", sha],
    signal,
    environment,
  );
  return materialized.exitCode === 0;
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
    scratchRefEnvironment(),
  );
  if (cleaned.exitCode !== 0) {
    throw new Error(`Failed to clean up GitHub pull-request ref ${sourceRef}`);
  }
}
