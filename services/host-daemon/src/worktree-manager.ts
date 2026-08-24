/* eslint-disable max-lines -- claim, checkout, and allowed-root policy share one manager. */
import {
  assertClaimedPathsAllowed,
  assertDaemonPathsAllowed,
  assertPathWithinAllowedRoots,
  type ClaimedPathsAllowed,
} from "./allowed-roots.ts";
import type { DaemonConfig, RepositoryConfig, WorktreeConfig } from "./config.ts";
import type { GitClient } from "./git.ts";

type ClaimedWorktree = {
  hostSetupScript?: string;
  repository: RepositoryConfig;
  worktree: WorktreeConfig;
  cwd: string;
  allowedRoots?: string[];
  /** Re-check the live inventory policy before each filesystem/CLI execution boundary. */
  currentExecutionTarget?: () => Promise<void>;
  /** Resolve hook policy again when a session finishes after a config reload. */
  currentHookTarget: () => Promise<{
    cwd: string;
    repository: RepositoryConfig;
    allowedRoots?: string[];
  } | null>;
};

type MainWaiter = {
  resolve: (acquired: boolean) => void;
  signal?: AbortSignal;
};

const mainWorktree = (repository: RepositoryConfig): WorktreeConfig => ({
  id: `main:${repository.id}`,
  name: "Main checkout",
  path: repository.path,
  labels: [],
});

export class WorktreeManager {
  private readonly busy = new Set<string>();
  private readonly mainBusy = new Set<string>();
  private readonly mainWaiters = new Map<string, MainWaiter[]>();
  private readonly config: DaemonConfig;
  private readonly git: GitClient;
  private inventoryGeneration = 0;
  private allowedRootsPolicyActive = false;
  private policyAllowedRoots: string[] = [];

  constructor(config: DaemonConfig, git: GitClient) {
    this.config = config;
    this.git = git;
  }

  /**
   * Keep an invalid polled policy in force for pending hooks even though the rest of the
   * inventory cannot be applied. An empty policy is intentionally fail-closed here.
   */
  setAllowedRootsPolicy(allowedRoots?: readonly string[]): void {
    this.allowedRootsPolicyActive = true;
    this.policyAllowedRoots = allowedRoots ? [...allowedRoots] : [];
    this.noteInventoryChange();
  }

  clearAllowedRootsPolicy(): void {
    this.allowedRootsPolicyActive = false;
    this.policyAllowedRoots = [];
    this.noteInventoryChange();
  }

  getAllowedRootsPolicy(): { active: boolean; roots: string[] } {
    return {
      active: this.allowedRootsPolicyActive,
      roots: [...this.policyAllowedRoots],
    };
  }

  restoreAllowedRootsPolicy(policy: { active: boolean; roots: readonly string[] }): void {
    this.allowedRootsPolicyActive = policy.active;
    this.policyAllowedRoots = policy.active ? [...policy.roots] : [];
    this.noteInventoryChange();
  }

  /** Invalidate claims that are waiting on filesystem validation during an inventory refresh. */
  noteInventoryChange(): void {
    this.inventoryGeneration += 1;
  }

  private effectiveAllowedRoots(): string[] {
    return this.allowedRootsPolicyActive
      ? this.policyAllowedRoots
      : (this.config.allowedRoots ?? []);
  }

  async ensureAll(): Promise<void> {
    await assertDaemonPathsAllowed(this.config);
    const roots = this.effectiveAllowedRoots();
    for (const repo of this.config.repositories) {
      const repositoryPath = await assertPathWithinAllowedRoots(repo.path, roots);
      await this.git.ensureRepo(repositoryPath);
      for (const wt of repo.worktrees) {
        const worktreePath = await assertPathWithinAllowedRoots(wt.path, roots);
        await this.git.ensureWorktree({
          repoPath: repositoryPath,
          worktreePath,
          branch: repo.defaultBranch,
        });
      }
    }
  }

  isBusy(worktreeId: string): boolean {
    return this.busy.has(worktreeId);
  }

  private claimedResult(
    repository: RepositoryConfig,
    worktree: WorktreeConfig,
    cwd: string,
    paths: ClaimedPathsAllowed,
    generation: number,
  ): ClaimedWorktree {
    const claimedRepository = { ...repository, path: paths.repositoryPath };
    const claimedWorktree = { ...worktree, path: cwd };
    return {
      ...(this.config.setupScript !== undefined
        ? { hostSetupScript: this.config.setupScript }
        : {}),
      ...(this.effectiveAllowedRoots().length
        ? { allowedRoots: this.effectiveAllowedRoots() }
        : {}),
      repository: claimedRepository,
      worktree: claimedWorktree,
      cwd,
      currentExecutionTarget: async () => {
        if (generation !== this.inventoryGeneration) {
          throw new Error("host inventory changed after this checkout was claimed");
        }
        const roots = this.effectiveAllowedRoots();
        if (this.allowedRootsPolicyActive && roots.length === 0) {
          throw new Error("host inventory policy blocks execution");
        }
        await assertClaimedPathsAllowed({
          cwd,
          repositoryPath: paths.repositoryPath,
          terminalHookScript: repository.terminalHookScript,
          allowedRoots: roots,
        });
        if (generation !== this.inventoryGeneration) {
          throw new Error("host inventory changed during execution validation");
        }
      },
      currentHookTarget: () => this.currentHookTarget(repository.id, cwd, paths.repositoryPath),
    };
  }

  /**
   * Resolve terminal-hook inputs from the live daemon config, not the assignment snapshot.
   * A session may remain pending while an inventory reload tightens or removes its policy.
   */
  private async currentHookTarget(
    repositoryId: string,
    claimedCwd: string,
    claimedRepositoryPath: string,
  ): Promise<{
    cwd: string;
    repository: RepositoryConfig;
    allowedRoots?: string[];
  } | null> {
    const repository = this.config.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) return null;
    const roots = this.effectiveAllowedRoots();
    if (this.allowedRootsPolicyActive && roots.length === 0) return null;
    const paths = await assertClaimedPathsAllowed({
      // A refreshed inventory may move or remove the worktree. Finish the session in the
      // originally claimed checkout, subject to the current root policy and hook config.
      cwd: claimedCwd,
      repositoryPath: claimedRepositoryPath,
      terminalHookScript: repository.terminalHookScript,
      allowedRoots: roots,
    });
    return {
      cwd: paths.cwd,
      repository: { ...repository, path: paths.repositoryPath },
      ...(roots.length ? { allowedRoots: roots } : {}),
    };
  }

  private async assertClaimPaths(
    repository: RepositoryConfig,
    cwd: string,
  ): Promise<ClaimedPathsAllowed> {
    return await assertClaimedPathsAllowed({
      cwd,
      repositoryPath: repository.path,
      terminalHookScript: repository.terminalHookScript,
      allowedRoots: this.effectiveAllowedRoots(),
    });
  }

  async claim(repositoryId: string, worktreeId: string): Promise<ClaimedWorktree> {
    if (this.busy.has(worktreeId)) {
      throw new Error(`Worktree already busy: ${worktreeId}`);
    }
    const repository = this.config.repositories.find((r) => r.id === repositoryId);
    if (!repository) {
      throw new Error(`Unknown repository: ${repositoryId}`);
    }
    const worktree = repository.worktrees.find((w) => w.id === worktreeId);
    if (!worktree) {
      throw new Error(`Unknown worktree: ${worktreeId}`);
    }
    this.busy.add(worktreeId);
    try {
      while (true) {
        const generation = this.inventoryGeneration;
        const currentRepository = this.config.repositories.find((r) => r.id === repositoryId);
        const currentWorktree = currentRepository?.worktrees.find((w) => w.id === worktreeId);
        if (!currentRepository || !currentWorktree) {
          if (generation !== this.inventoryGeneration) continue;
          throw new Error(
            !currentRepository
              ? `Unknown repository: ${repositoryId}`
              : `Unknown worktree: ${worktreeId}`,
          );
        }
        let paths: ClaimedPathsAllowed;
        try {
          paths = await this.assertClaimPaths(currentRepository, currentWorktree.path);
        } catch (error) {
          if (generation !== this.inventoryGeneration) continue;
          throw error;
        }
        if (generation !== this.inventoryGeneration) continue;
        return this.claimedResult(currentRepository, currentWorktree, paths.cwd, paths, generation);
      }
    } catch (error) {
      this.busy.delete(worktreeId);
      throw error;
    }
  }

  async mainClaim(repositoryId: string): Promise<ClaimedWorktree> {
    while (true) {
      const generation = this.inventoryGeneration;
      const repository = this.config.repositories.find((r) => r.id === repositoryId);
      if (!repository) {
        if (generation !== this.inventoryGeneration) continue;
        throw new Error(`Unknown repository: ${repositoryId}`);
      }
      let paths: ClaimedPathsAllowed;
      try {
        paths = await this.assertClaimPaths(repository, repository.path);
      } catch (error) {
        if (generation !== this.inventoryGeneration) continue;
        throw error;
      }
      if (generation !== this.inventoryGeneration) continue;
      return this.claimedResult(repository, mainWorktree(repository), paths.cwd, paths, generation);
    }
  }

  async acquireMain(repositoryId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (!this.mainBusy.has(repositoryId)) {
      this.mainBusy.add(repositoryId);
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const waiter: MainWaiter = { resolve, ...(signal ? { signal } : {}) };
      const waiters = this.mainWaiters.get(repositoryId) ?? [];
      waiters.push(waiter);
      this.mainWaiters.set(repositoryId, waiters);
      signal?.addEventListener(
        "abort",
        () => {
          const current = this.mainWaiters.get(repositoryId);
          if (!current) return;
          const index = current.indexOf(waiter);
          if (index < 0) return;
          current.splice(index, 1);
          if (current.length === 0) this.mainWaiters.delete(repositoryId);
          resolve(false);
        },
        { once: true },
      );
    });
  }

  releaseMain(repositoryId: string): void {
    if (!this.mainBusy.has(repositoryId)) return;
    const waiters = this.mainWaiters.get(repositoryId) ?? [];
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.resolve(false);
        continue;
      }
      waiter.resolve(true);
      return;
    }
    this.mainWaiters.delete(repositoryId);
    this.mainBusy.delete(repositoryId);
  }

  release(worktreeId: string): void {
    this.busy.delete(worktreeId);
  }

  /**
   * Prepare worktree checkout for a session ref (D6).
   * When ref is omitted, reset to the repository default branch.
   */
  async prepareCheckout(
    claimed: ClaimedWorktree,
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await claimed.currentExecutionTarget?.();
    const target = ref ?? claimed.repository.defaultBranch;
    await this.git.checkoutRef({ cwd: claimed.cwd, ref: target, ...(signal ? { signal } : {}) });
  }

  async prepareMainCheckout(
    claimed: ClaimedWorktree,
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await claimed.currentExecutionTarget?.();
    const target = ref ?? claimed.repository.defaultBranch;
    await this.git.prepareMainCheckout({
      cwd: claimed.cwd,
      ref: target,
      ...(signal ? { signal } : {}),
    });
  }
}
