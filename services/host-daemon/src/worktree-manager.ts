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
  }

  clearAllowedRootsPolicy(): void {
    this.allowedRootsPolicyActive = false;
    this.policyAllowedRoots = [];
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
    main = false,
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
      currentHookTarget: () =>
        this.currentHookTarget(repository.id, main ? undefined : worktree.id),
    };
  }

  /**
   * Resolve terminal-hook inputs from the live daemon config, not the assignment snapshot.
   * A session may remain pending while an inventory reload tightens or removes its policy.
   */
  private async currentHookTarget(
    repositoryId: string,
    worktreeId: string | undefined,
  ): Promise<{
    cwd: string;
    repository: RepositoryConfig;
    allowedRoots?: string[];
  } | null> {
    const repository = this.config.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) return null;
    const roots = this.effectiveAllowedRoots();
    if (this.allowedRootsPolicyActive && roots.length === 0) return null;
    if (worktreeId !== undefined) {
      const worktree = repository.worktrees.find((candidate) => candidate.id === worktreeId);
      if (!worktree) return null;
      const paths = await assertClaimedPathsAllowed({
        cwd: worktree.path,
        repositoryPath: repository.path,
        terminalHookScript: repository.terminalHookScript,
        allowedRoots: roots,
      });
      return {
        cwd: paths.cwd,
        repository: { ...repository, path: paths.repositoryPath },
        ...(roots.length ? { allowedRoots: roots } : {}),
      };
    }
    const paths = await assertClaimedPathsAllowed({
      cwd: repository.path,
      repositoryPath: repository.path,
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
      const paths = await this.assertClaimPaths(repository, worktree.path);
      return this.claimedResult(repository, worktree, paths.cwd, paths);
    } catch (error) {
      this.busy.delete(worktreeId);
      throw error;
    }
  }

  async mainClaim(repositoryId: string): Promise<ClaimedWorktree> {
    const repository = this.config.repositories.find((r) => r.id === repositoryId);
    if (!repository) {
      throw new Error(`Unknown repository: ${repositoryId}`);
    }
    const paths = await this.assertClaimPaths(repository, repository.path);
    return this.claimedResult(repository, mainWorktree(repository), paths.cwd, paths, true);
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
    const target = ref ?? claimed.repository.defaultBranch;
    await this.git.checkoutRef({ cwd: claimed.cwd, ref: target, ...(signal ? { signal } : {}) });
  }

  async prepareMainCheckout(
    claimed: ClaimedWorktree,
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = ref ?? claimed.repository.defaultBranch;
    await this.git.prepareMainCheckout({
      cwd: claimed.cwd,
      ref: target,
      ...(signal ? { signal } : {}),
    });
  }
}
