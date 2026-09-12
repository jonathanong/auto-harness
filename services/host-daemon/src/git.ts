/* eslint-disable max-lines -- Git client operations share checkout safety invariants. */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import {
  checkoutFetchFailure,
  gitFailure,
  refetchConfiguredRemotes,
  runGit,
} from "./git-commands.ts";
import {
  claimedLinkedWorktreeCommonDir,
  checkoutDetached,
  removeStaleIndexLock,
  resetClaimedWorktree,
} from "./git-worktree-checkout.ts";
import { resetInitializedSubmodules } from "./git-worktree-reset.ts";

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

export function createGitClient(runner: ProcessRunner): GitClient {
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
      const claimedCommonDir = await claimedLinkedWorktreeCommonDir(repoPath, cwd);
      if (claimedCommonDir === null) {
        throw new Error("Configured checkout is not the claimed linked worktree");
      }
      await removeStaleIndexLock(runner, cwd, claimedCommonDir, signal);
      if (!(await resetClaimedWorktree(runner, cwd, claimedCommonDir, signal))) {
        throw new Error("Configured checkout is not the claimed linked worktree");
      }
      // Prefer detached checkout so a branch already used by the main repo
      // (e.g. ref "main" while primary tree is on main) still works.
      // `--end-of-options` stops git from reading `ref` as a flag: unlike most git
      // subcommands, a plain `--` before the ref makes `rev-parse --verify` treat it
      // as a pathspec instead of a revision ("Needed a single revision"), so this is
      // the git-native separator here rather than `--` (see `switch -- ref` below,
      // which does accept plain `--`).
      const commitRef = `${ref}^{commit}`;
      let resolved = await runGit(
        runner,
        cwd,
        ["rev-parse", "--verify", "--end-of-options", commitRef],
        signal,
      );
      if (resolved.exitCode !== 0) {
        let fetched: Awaited<ReturnType<typeof runGit>>;
        try {
          fetched = await runGit(runner, cwd, ["fetch", "--all", "--tags"], signal);
        } catch (error) {
          throw checkoutFetchFailure(
            `Failed to fetch ref ${ref}`,
            error instanceof Error ? error.message : String(error),
          );
        }
        if (fetched.exitCode !== 0) {
          resolved = await runGit(
            runner,
            cwd,
            ["rev-parse", "--verify", "--end-of-options", commitRef],
            signal,
          );
          if (resolved.exitCode !== 0) {
            throw checkoutFetchFailure(`Failed to fetch ref ${ref}`, fetched.stderr);
          }
        }
        if (fetched.exitCode === 0) {
          resolved = await runGit(
            runner,
            cwd,
            ["rev-parse", "--verify", "--end-of-options", commitRef],
            signal,
          );
        }
      }
      if (resolved.exitCode !== 0) {
        throw gitFailure(`Failed to resolve ref ${ref}`, resolved.stderr);
      }
      const sha = resolved.stdout.trim();
      let co = await checkoutDetached(runner, cwd, sha, signal);
      if (co.exitCode !== 0 && co.stderr.includes("index.lock")) {
        if (await removeStaleIndexLock(runner, cwd, claimedCommonDir, signal)) {
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
          let refetchFailure;
          const refetched = await refetchConfiguredRemotes(
            runner,
            cwd,
            signal,
            false,
            (failure) => {
              refetchFailure = failure;
            },
          );
          co = await checkoutDetached(runner, cwd, sha, signal);
          if (co.exitCode !== 0 && refetchFailure) throw refetchFailure;
          if (!refetched && co.exitCode !== 0) {
            throw new Error("Failed to fetch required checkout objects");
          }
        }
      }
      if (co.exitCode !== 0) {
        throw gitFailure("Failed to checkout resolved ref", co.stderr);
      }
      await resetInitializedSubmodules(runner, cwd, signal);
      const head = await runGit(runner, cwd, ["rev-parse", "HEAD"], signal);
      if (head.exitCode !== 0 || head.stdout.trim() !== sha) {
        throw new Error("Failed to verify detached checkout");
      }
      const detached = await runGit(runner, cwd, ["symbolic-ref", "--quiet", "HEAD"], signal);
      if (detached.exitCode !== 1) {
        throw new Error("Failed to verify detached checkout");
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
        let fetched: Awaited<ReturnType<typeof runGit>>;
        try {
          fetched = await runGit(runner, cwd, ["fetch", "--all", "--tags"], signal);
        } catch (error) {
          throw checkoutFetchFailure(
            `Failed to fetch branch ${ref}`,
            error instanceof Error ? error.message : String(error),
          );
        }
        if (fetched.exitCode !== 0) {
          switched = await runGit(runner, cwd, ["switch", "--", ref], signal);
          if (switched.exitCode !== 0) {
            throw checkoutFetchFailure(`Failed to fetch branch ${ref}`, fetched.stderr);
          }
        }
        if (fetched.exitCode === 0) {
          switched = await runGit(runner, cwd, ["switch", "--", ref], signal);
        }
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
