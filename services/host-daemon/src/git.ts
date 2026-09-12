/* eslint-disable max-lines -- checkout preparation, exact ref resolution, and verification share one client. */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { createChildEnv } from "./child-env.ts";
import type { ProcessRunner } from "./executor.ts";
import { gitFailure, refetchConfiguredRemotes, runGit } from "./git-commands.ts";
import {
  deleteGitHubPullRequestRef,
  fetchGitHubPullRequestRef,
  gitObjectFormat,
  isGitHubPullRequestRef,
  nullGlobalGitConfigPath,
  type GitHubPullRequestFetch,
} from "./git-github-pull-ref.ts";
import {
  claimedLinkedWorktreeCommonDir,
  checkoutDetached,
  removeStaleIndexLock,
  resetClaimedWorktree,
} from "./git-worktree-checkout.ts";
import { resetInitializedSubmodules } from "./git-worktree-reset.ts";
import { type GitHubPullRefConfigs } from "./github-pull-ref-config.ts";

export type GitClient = {
  ensureRepo(path: string): Promise<void>;
  ensureWorktree(opts: { repoPath: string; worktreePath: string; branch: string }): Promise<void>;
  checkoutRef(opts: {
    cwd: string;
    repoPath: string;
    ref: string;
    signal?: AbortSignal;
  }): Promise<string | undefined>;
  prepareMainCheckout(opts: { cwd: string; ref: string; signal?: AbortSignal }): Promise<void>;
  revParse(cwd: string, rev: string, signal?: AbortSignal): Promise<string>;
};

async function canonicalPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch {
    // Keep lexical normalization for scripted or not-yet-created paths.
    return absolutePath;
  }
}

async function listedWorktreePaths(output: string, repoPath: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const worktreePath = line.slice("worktree ".length);
    if (worktreePath.length > 0) {
      paths.add(await canonicalPath(resolve(repoPath, worktreePath)));
    }
  }
  return paths;
}

function isolatedPullCheckoutEnvironment(): NodeJS.ProcessEnv {
  return {
    ...createChildEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: nullGlobalGitConfigPath(),
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_VALUE_0: nullGlobalGitConfigPath(),
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

export function createGitClient(
  runner: ProcessRunner,
  pullRefConfigs: GitHubPullRefConfigs | undefined = undefined,
): GitClient {
  async function pullRefConfig(path: string) {
    const key = await canonicalPath(path);
    return pullRefConfigs?.get(key) ?? pullRefConfigs?.get(resolve(path));
  }

  return {
    async ensureRepo(path: string) {
      const probe = await runGit(runner, path, ["rev-parse", "--is-inside-work-tree"]);
      if (probe.exitCode !== 0) {
        throw new Error(`Not a git repository: ${path}`);
      }
    },

    async ensureWorktree({ repoPath, worktreePath, branch }) {
      await this.ensureRepo(repoPath);
      const list = await runGit(runner, repoPath, ["worktree", "list", "--porcelain"]);
      const worktreeIdentity = await canonicalPath(resolve(repoPath, worktreePath));
      if ((await listedWorktreePaths(list.stdout, repoPath)).has(worktreeIdentity)) {
        return;
      }
      // Always add detached so the branch can remain checked out in the main tree.
      let tip = await runGit(runner, repoPath, ["rev-parse", "--verify", branch]);
      if (tip.exitCode !== 0) {
        tip = await runGit(runner, repoPath, ["rev-parse", "--verify", "HEAD"]);
      }
      if (tip.exitCode !== 0) {
        throw gitFailure(`Failed to resolve tip for worktree ${worktreePath}`, tip.stderr);
      }
      const sha = tip.stdout.trim();
      const add = await runGit(runner, repoPath, [
        "worktree",
        "add",
        "--detach",
        worktreeIdentity,
        sha,
      ]);
      if (add.exitCode !== 0) {
        throw gitFailure(`Failed to create worktree at ${worktreeIdentity}`, add.stderr);
      }
    },

    async checkoutRef({ cwd, repoPath, ref, signal }) {
      const isPullRequestRef = isGitHubPullRequestRef(ref);
      const pullCheckoutEnvironment = isPullRequestRef
        ? isolatedPullCheckoutEnvironment()
        : undefined;
      const claimedCommonDir = await claimedLinkedWorktreeCommonDir(repoPath, cwd);
      if (claimedCommonDir === null) {
        throw new Error("Configured checkout is not the claimed linked worktree");
      }
      await removeStaleIndexLock(runner, cwd, claimedCommonDir, signal);
      if (
        !(await resetClaimedWorktree(
          runner,
          cwd,
          claimedCommonDir,
          signal,
          pullCheckoutEnvironment,
        ))
      ) {
        throw new Error("Configured checkout is not the claimed linked worktree");
      }
      // Prefer detached checkout so a branch already used by the main repo
      // (e.g. ref "main" while primary tree is on main) still works.
      // `--end-of-options` stops git from reading `ref` as a flag: unlike most git
      // subcommands, a plain `--` before the ref makes `rev-parse --verify` treat it
      // as a pathspec instead of a revision ("Needed a single revision"), so this is
      // the git-native separator here rather than `--` (see `switch -- ref` below,
      // which does accept plain `--`).
      let pullRequestFetch: GitHubPullRequestFetch | null = null;
      let sha = "";
      try {
        const pullConfig = isPullRequestRef ? await pullRefConfig(repoPath) : undefined;
        const localFilters =
          isPullRequestRef && pullConfig !== undefined
            ? await runGit(runner, cwd, ["config", "--local", "--get-regexp", "^filter\\."], signal)
            : undefined;
        // Materializing an exact commit through a session-controlled filter can change worktree
        // bytes while keeping HEAD unchanged. Pull-ref policy deliberately fails closed instead of
        // accepting any local filter driver in the shared checkout.
        const filtersAreAbsent = localFilters?.exitCode === 1;
        if (isPullRequestRef && pullConfig !== undefined && !filtersAreAbsent) {
          throw new Error("Configured pull-ref checkout has repository-local filters");
        }
        const objectFormat =
          isPullRequestRef && pullConfig !== undefined
            ? await runGit(runner, cwd, ["rev-parse", "--show-object-format=storage"], signal)
            : undefined;
        const targetObjectFormat =
          objectFormat?.exitCode === 0 ? gitObjectFormat(objectFormat.stdout.trim()) : undefined;
        const objectDirectory =
          isPullRequestRef && pullConfig !== undefined
            ? await runGit(
                runner,
                cwd,
                ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
                signal,
              )
            : undefined;
        const shallow =
          objectDirectory?.exitCode === 0
            ? await runGit(runner, cwd, ["rev-parse", "--is-shallow-repository"], signal)
            : undefined;
        const partialClone =
          shallow?.exitCode === 0 && shallow.stdout.trim() === "false"
            ? await runGit(
                runner,
                cwd,
                [
                  "config",
                  "--local",
                  "--get-regexp",
                  "^(extensions\\.partialClone|remote\\..*\\.promisor)$",
                ],
                signal,
              )
            : undefined;
        // An alternate object directory does not carry the checkout's shallow boundary. Advertise
        // it only after proving this repository has complete history; otherwise fetch the exact
        // pull head without an alternate or base exclusion.
        const reusesObjects =
          filtersAreAbsent &&
          shallow?.exitCode === 0 &&
          shallow.stdout.trim() === "false" &&
          partialClone?.exitCode === 1;
        const base = reusesObjects
          ? await runGit(runner, cwd, ["rev-parse", "HEAD"], signal)
          : undefined;
        pullRequestFetch = isPullRequestRef
          ? targetObjectFormat === undefined || !filtersAreAbsent
            ? null
            : await fetchGitHubPullRequestRef(
                runner,
                cwd,
                ref,
                pullConfig,
                reusesObjects ? objectDirectory?.stdout.trim() : undefined,
                base?.exitCode === 0 ? base.stdout.trim() : undefined,
                signal,
                targetObjectFormat,
              )
          : null;
        if (isPullRequestRef && pullRequestFetch === null) {
          throw new Error(`Failed to fetch GitHub pull-request ref ${ref}`);
        }
        let resolved = isPullRequestRef
          ? undefined
          : await runGit(
              runner,
              cwd,
              ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
              signal,
            );
        if (resolved !== undefined && resolved.exitCode !== 0) {
          await runGit(runner, cwd, ["fetch", "--all", "--tags"], signal);
          resolved = await runGit(
            runner,
            cwd,
            ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
            signal,
          );
        }
        if (resolved !== undefined && resolved.exitCode !== 0) {
          throw gitFailure(`Failed to resolve ref ${ref}`, resolved.stderr);
        }
        sha = pullRequestFetch?.sha ?? resolved?.stdout.trim() ?? "";
        let co = await checkoutDetached(runner, cwd, sha, signal, pullCheckoutEnvironment);
        if (co.exitCode !== 0 && co.stderr.includes("index.lock")) {
          if (await removeStaleIndexLock(runner, cwd, claimedCommonDir, signal)) {
            co = await checkoutDetached(runner, cwd, sha, signal, pullCheckoutEnvironment);
          }
        }
        if (co.exitCode !== 0) {
          // A regular fetch can treat the locally-present commit as complete
          // while its graph is missing an object. Repair only that condition,
          // rather than masking ordinary checkout failures with a network retry.
          const connectivity = await runGit(
            runner,
            cwd,
            ["fsck", "--connectivity-only", sha],
            signal,
          );
          if (connectivity.exitCode !== 0) {
            if (isPullRequestRef) {
              throw new Error("Failed to verify GitHub pull-request checkout objects");
            }
            if (!(await refetchConfiguredRemotes(runner, cwd, signal))) {
              throw new Error("Failed to fetch required checkout objects");
            }
            co = await checkoutDetached(runner, cwd, sha, signal, pullCheckoutEnvironment);
          }
        }
        if (co.exitCode !== 0) {
          throw gitFailure("Failed to checkout resolved ref", co.stderr);
        }
        await resetInitializedSubmodules(runner, cwd, signal, pullCheckoutEnvironment);
        const head = await runGit(runner, cwd, ["rev-parse", "HEAD"], signal);
        if (head.exitCode !== 0 || head.stdout.trim() !== sha) {
          throw new Error("Failed to verify detached checkout");
        }
        const detached = await runGit(runner, cwd, ["symbolic-ref", "--quiet", "HEAD"], signal);
        if (detached.exitCode !== 1) {
          throw new Error("Failed to verify detached checkout");
        }
      } finally {
        if (pullRequestFetch !== null) {
          // Cleanup must run even after the execution deadline aborts the checkout signal.
          await deleteGitHubPullRequestRef(
            runner,
            cwd,
            pullRequestFetch.ref,
            ref,
            AbortSignal.timeout(10_000),
          );
        }
      }
      return sha;
    },

    async prepareMainCheckout({ cwd, ref, signal }) {
      // Main checkouts may contain a branch that maintenance commands commit
      // and push. Never detach or reset this checkout, and let dirty-tree
      // conflicts fail rather than overwrite operator work.
      const format = await runGit(runner, cwd, ["check-ref-format", "--branch", ref], signal);
      if (format.exitCode !== 0) {
        throw new Error(`Invalid main checkout branch ref: ${ref}`);
      }
      const status = await runGit(runner, cwd, ["status", "--porcelain"], signal);
      if (status.exitCode !== 0) {
        throw new Error(`Failed to inspect main checkout before switching to branch ${ref}`);
      }
      if (status.stdout.length > 0) {
        throw new Error(`Main checkout has uncommitted changes; refusing to switch branch ${ref}`);
      }
      const localBranch = await runGit(
        runner,
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`],
        signal,
      );
      let switched = await runGit(runner, cwd, ["switch", "--", ref], signal);
      if (switched.exitCode !== 0) {
        if (localBranch.exitCode === 0) {
          throw gitFailure(`Failed to switch main checkout to branch ${ref}`, switched.stderr);
        }
        const fetched = await runGit(runner, cwd, ["fetch", "--all", "--tags"], signal);
        if (fetched.exitCode !== 0) {
          throw gitFailure(`Failed to fetch branch ${ref}`, fetched.stderr);
        }
        switched = await runGit(runner, cwd, ["switch", "--", ref], signal);
      }
      if (switched.exitCode !== 0) {
        throw gitFailure(`Failed to switch main checkout to branch ${ref}`, switched.stderr);
      }
      const current = await runGit(
        runner,
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        signal,
      );
      if (current.exitCode !== 0 || current.stdout.trim() !== ref) {
        throw new Error(`Main checkout is not on branch ${ref}`);
      }
    },

    async revParse(cwd, rev, signal) {
      const result = await runGit(runner, cwd, ["rev-parse", rev], signal);
      if (result.exitCode !== 0) {
        throw gitFailure(`git rev-parse ${rev} failed`, result.stderr);
      }
      return result.stdout.trim();
    },
  };
}
