import { assertDaemonPathsAllowed } from "./allowed-roots.ts";
import type { DaemonConfig, RepositoryConfig, WorktreeConfig } from "./config.ts";
import type { GitClient } from "./git.ts";

type ClaimedWorktree = {
  hostSetupScript?: string;
  repository: RepositoryConfig;
  worktree: WorktreeConfig;
  cwd: string;
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

  constructor(config: DaemonConfig, git: GitClient) {
    this.config = config;
    this.git = git;
  }

  async ensureAll(): Promise<void> {
    await assertDaemonPathsAllowed(this.config);
    for (const repo of this.config.repositories) {
      await this.git.ensureRepo(repo.path);
      for (const wt of repo.worktrees) {
        await this.git.ensureWorktree({
          repoPath: repo.path,
          worktreePath: wt.path,
          branch: repo.defaultBranch,
        });
      }
    }
  }

  isBusy(worktreeId: string): boolean {
    return this.busy.has(worktreeId);
  }

  claim(repositoryId: string, worktreeId: string): ClaimedWorktree {
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
    return {
      ...(this.config.setupScript !== undefined
        ? { hostSetupScript: this.config.setupScript }
        : {}),
      repository,
      worktree,
      cwd: worktree.path,
    };
  }

  mainClaim(repositoryId: string): ClaimedWorktree {
    const repository = this.config.repositories.find((r) => r.id === repositoryId);
    if (!repository) {
      throw new Error(`Unknown repository: ${repositoryId}`);
    }
    return {
      ...(this.config.setupScript !== undefined
        ? { hostSetupScript: this.config.setupScript }
        : {}),
      repository,
      worktree: mainWorktree(repository),
      cwd: repository.path,
    };
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
