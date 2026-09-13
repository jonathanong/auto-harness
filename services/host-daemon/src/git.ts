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
  materializeGitHubPullRequestRef,
  nullGlobalGitConfigPath,
  type GitHubPullRequestFetch,
} from "./git-github-pull-ref.ts";
import {
  claimedLinkedWorktree,
  checkoutDetached,
  hasInterruptedWorktreeOperation,
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
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_GLOBAL: nullGlobalGitConfigPath(),
    GIT_CONFIG_KEY_0: "core.hooksPath",
    // A pull head controls .gitmodules. Keep normal checkout commands from honoring a prior
    // session's recursive-submodule preference before the pull-ref-specific guard can reject it.
    GIT_CONFIG_KEY_1: "submodule.recurse",
    // A prior session can configure an executable fsmonitor. Keep it disabled for every command
    // that still targets the claimed Git directory; materialization itself uses a separate one.
    GIT_CONFIG_KEY_2: "core.fsmonitor",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_VALUE_0: nullGlobalGitConfigPath(),
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_VALUE_2: "false",
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
      const pullConfig = isPullRequestRef ? await pullRefConfig(repoPath) : undefined;
      if (isPullRequestRef && pullConfig === undefined) {
        throw new Error("Configured pull-ref checkout has no operator policy");
      }
      const claimedWorktree = await claimedLinkedWorktree(repoPath, cwd);
      if (claimedWorktree === null) {
        throw new Error("Configured checkout is not the claimed linked worktree");
      }
      if (isPullRequestRef && (await hasInterruptedWorktreeOperation(claimedWorktree.gitDir))) {
        throw new Error("Configured pull-ref checkout has interrupted worktree state");
      }
      await removeStaleIndexLock(
        runner,
        cwd,
        claimedWorktree.commonDir,
        signal,
        pullCheckoutEnvironment,
      );
      if (
        !isPullRequestRef &&
        !(await resetClaimedWorktree(runner, cwd, claimedWorktree.commonDir, signal))
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
        const objectFormat =
          isPullRequestRef && pullConfig !== undefined
            ? await runGit(
                runner,
                cwd,
                ["rev-parse", "--show-object-format=storage"],
                signal,
                pullCheckoutEnvironment,
              )
            : undefined;
        const targetObjectFormat =
          objectFormat?.exitCode === 0 ? gitObjectFormat(objectFormat.stdout.trim()) : undefined;
        pullRequestFetch = isPullRequestRef
          ? targetObjectFormat === undefined
            ? null
            : await fetchGitHubPullRequestRef(
                runner,
                cwd,
                ref,
                pullConfig,
                resolve(claimedWorktree.commonDir, "objects"),
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
        sha = isPullRequestRef ? pullRequestFetch!.sha : resolved!.stdout.trim();
        if (isPullRequestRef) {
          const materialized = await materializeGitHubPullRequestRef(
            runner,
            pullConfig!.materializerGitDirs[targetObjectFormat!],
            cwd,
            sha,
            resolve(claimedWorktree.commonDir, "objects"),
            resolve(claimedWorktree.gitDir, "index"),
            targetObjectFormat!,
            signal,
          );
          if (!materialized) {
            throw new Error("Failed to materialize GitHub pull-request ref");
          }
          const detached = await runGit(
            runner,
            cwd,
            ["update-ref", "--no-deref", "HEAD", sha],
            signal,
            pullCheckoutEnvironment,
          );
          if (detached.exitCode !== 0) {
            throw new Error("Failed to detach GitHub pull-request checkout");
          }
        } else {
          let co = await checkoutDetached(runner, cwd, sha, signal);
          if (co.exitCode !== 0 && co.stderr.includes("index.lock")) {
            if (await removeStaleIndexLock(runner, cwd, claimedWorktree.commonDir, signal)) {
              co = await checkoutDetached(runner, cwd, sha, signal);
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
              if (!(await refetchConfiguredRemotes(runner, cwd, signal))) {
                throw new Error("Failed to fetch required checkout objects");
              }
              co = await checkoutDetached(runner, cwd, sha, signal);
            }
          }
          if (co.exitCode !== 0) {
            throw gitFailure("Failed to checkout resolved ref", co.stderr);
          }
        }
        if (isPullRequestRef) {
          // A pull head controls .gitmodules. Do not sync or update even an already initialized
          // submodule from that untrusted tree; status only reads the checked-out gitlinks, then
          // rejects them before the session can run against stale or newly materialized contents.
          const submodules = await runGit(
            runner,
            cwd,
            ["submodule", "status", "--recursive"],
            signal,
            pullCheckoutEnvironment,
          );
          if (submodules.exitCode !== 0 || submodules.stdout.trim().length > 0) {
            throw new Error("Configured pull-ref checkout contains submodules");
          }
        } else {
          await resetInitializedSubmodules(runner, cwd, signal);
        }
        const head = await runGit(
          runner,
          cwd,
          ["rev-parse", "HEAD"],
          signal,
          pullCheckoutEnvironment,
        );
        if (head.exitCode !== 0 || head.stdout.trim() !== sha) {
          throw new Error("Failed to verify detached checkout");
        }
        const detached = await runGit(
          runner,
          cwd,
          ["symbolic-ref", "--quiet", "HEAD"],
          signal,
          pullCheckoutEnvironment,
        );
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
