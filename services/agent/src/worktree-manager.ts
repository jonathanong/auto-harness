import type { AgentConfig, RepositoryConfig, WorktreeConfig } from "./config.js";
import type { GitClient } from "./git.js";

type ClaimedWorktree = {
  repository: RepositoryConfig;
  worktree: WorktreeConfig;
  cwd: string;
};

export class WorktreeManager {
  private readonly busy = new Set<string>();

  constructor(
    private readonly config: AgentConfig,
    private readonly git: GitClient,
  ) {}

  async ensureAll(): Promise<void> {
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
    return { repository, worktree, cwd: worktree.path };
  }

  release(worktreeId: string): void {
    this.busy.delete(worktreeId);
  }

  /**
   * Prepare worktree checkout for a session ref (D6).
   * When ref is omitted, reset to the repository default branch.
   */
  async prepareCheckout(claimed: ClaimedWorktree, ref: string | undefined): Promise<void> {
    const target = ref ?? claimed.repository.defaultBranch;
    await this.git.checkoutRef({ cwd: claimed.cwd, ref: target });
  }
}
