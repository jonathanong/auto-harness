/* eslint-disable max-lines -- claim, checkout, and allowed-root policy share one manager. */
import {
  assertClaimedPathsAllowed,
  assertDaemonPathsAllowed,
  assertPathWithinAllowedRoots,
  type ClaimedPathsAllowed,
} from "./allowed-roots.ts";
import type { DaemonConfig, RepositoryConfig, WorktreeConfig } from "./config.ts";
import type { GitClient } from "./git.ts";
import { FULL_COMMIT_ID } from "./git-ref-resolution.ts";

export type ClaimedWorktree = {
  hostSetupScript?: string;
  hostSetupCacheInputs?: string[];
  hostSetupCacheHostInputs?: string[];
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

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "") === (right ?? "");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A configured worktree whose checkout is not on disk yet; it is neither advertised nor claimable. */
type PendingWorktree = {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  failures: number;
  retryAt: number;
};

type MaterializeHooks = {
  signal?: AbortSignal;
  onReady?: () => void;
  onError?: (message: string) => void;
  now?: () => number;
};

const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

const pendingKey = (repositoryId: string, worktreeId: string, path: string) =>
  `${repositoryId}\n${worktreeId}\n${path}`;

export class WorktreeManager {
  private pending = new Map<string, PendingWorktree>();
  private materializing: Promise<void> | undefined;
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

  async ensureAll(candidate?: DaemonConfig, signal?: AbortSignal): Promise<void> {
    const generation = this.inventoryGeneration;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (generation !== this.inventoryGeneration) {
        throw new Error("host inventory changed during preparation");
      }
    };
    assertCurrent();
    if (!candidate && this.allowedRootsPolicyActive && this.policyAllowedRoots.length === 0) {
      throw new Error("host inventory policy blocks execution");
    }
    const config = candidate ?? this.config;
    const pending = new Map<string, PendingWorktree>();
    // Candidate validation must not replace an active retained policy: pending
    // terminal hooks continue to read `this.config` and `effectiveAllowedRoots()`
    // until the candidate registration has succeeded.
    // An explicitly supplied candidate with no allowedRoots intentionally
    // clears the restriction. Only a normal (non-candidate) preparation reads
    // the active retained policy.
    const roots =
      candidate === undefined ? this.effectiveAllowedRoots() : (candidate.allowedRoots ?? []);
    await assertDaemonPathsAllowed({ ...config, allowedRoots: roots });
    assertCurrent();
    for (const repo of config.repositories) {
      const repositoryPath = await assertPathWithinAllowedRoots(repo.path, roots);
      assertCurrent();
      if (signal) await this.git.ensureRepo(repositoryPath, signal);
      else await this.git.ensureRepo(repositoryPath);
      assertCurrent();
      for (const wt of repo.worktrees) {
        const worktreePath = await assertPathWithinAllowedRoots(wt.path, roots);
        assertCurrent();
        // Adoption only checks that git lists the worktree. Creating a missing checkout can take
        // minutes on a large repository, so it runs in materializePending() under its own bound
        // instead of inside the short assignment-refresh deadline, and one slow or failing
        // checkout never blocks adopting the rest of the inventory.
        const state = await this.git.ensureWorktree({
          repoPath: repositoryPath,
          worktreePath,
          branch: repo.defaultBranch,
          createMissing: false,
          ...(signal ? { signal } : {}),
        });
        assertCurrent();
        if (state !== "missing") continue;
        const key = pendingKey(repo.id, wt.id, wt.path);
        pending.set(
          key,
          this.pending.get(key) ?? {
            repositoryPath,
            worktreePath,
            branch: repo.defaultBranch,
            failures: 0,
            retryAt: 0,
          },
        );
      }
    }
    this.pending = pending;
  }

  /** Whether the worktree's checkout exists, so it can be advertised and claimed. */
  isMaterialized(repositoryId: string, worktree: WorktreeConfig): boolean {
    return !this.pending.has(pendingKey(repositoryId, worktree.id, worktree.path));
  }

  /** A configured worktree that is still waiting for its checkout to exist. */
  isPendingTarget(repositoryId: string, worktreeId: string | null): boolean {
    if (worktreeId === null) return false;
    const repository = this.config.repositories.find((candidate) => candidate.id === repositoryId);
    return (
      repository?.worktrees.some(
        (worktree) => worktree.id === worktreeId && !this.isMaterialized(repositoryId, worktree),
      ) ?? false
    );
  }

  /**
   * Create missing worktree checkouts one at a time. Single-flight; each checkout is bounded by
   * the git worktree-add timeout and cleans up after itself, and a failure only backs off that
   * worktree. `onReady` fires after each success so the new target can be advertised.
   */
  materializePending(hooks: MaterializeHooks = {}): Promise<void> {
    this.materializing ??= this.runMaterialization(hooks).finally(() => {
      this.materializing = undefined;
    });
    return this.materializing;
  }

  private async runMaterialization(hooks: MaterializeHooks): Promise<void> {
    const now = hooks.now ?? Date.now;
    for (const [key, entry] of this.pending) {
      if (hooks.signal?.aborted) return;
      if (this.pending.get(key) !== entry || entry.retryAt > now()) continue;
      try {
        await this.git.ensureWorktree({
          repoPath: entry.repositoryPath,
          worktreePath: entry.worktreePath,
          branch: entry.branch,
          ...(hooks.signal ? { signal: hooks.signal } : {}),
        });
      } catch (error) {
        if (hooks.signal?.aborted) return;
        entry.failures += 1;
        entry.retryAt = now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (entry.failures - 1));
        const message = error instanceof Error ? error.message : String(error);
        hooks.onError?.(`worktree ${entry.worktreePath} not ready: ${message}`);
        continue;
      }
      if (this.pending.get(key) === entry) {
        this.pending.delete(key);
        hooks.onReady?.();
      }
    }
  }

  isBusy(worktreeId: string): boolean {
    return this.busy.has(worktreeId);
  }

  /** Whether the live inventory can satisfy this repository assignment target. */
  hasAssignmentTarget(repositoryId: string, worktreeId: string | null): boolean {
    const repository = this.config.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) return false;
    return (
      worktreeId === null ||
      repository.worktrees.some(
        (worktree) => worktree.id === worktreeId && this.isMaterialized(repositoryId, worktree),
      )
    );
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
    const claimedAllowedRoots = this.effectiveAllowedRoots();
    const claimedHostSetupScript = this.config.setupScript;
    const claimedHostSetupCacheInputs = this.config.setupCacheInputs ?? [];
    const claimedHostSetupCacheHostInputs = this.config.setupCacheHostInputs ?? [];
    return {
      ...(claimedHostSetupScript !== undefined ? { hostSetupScript: claimedHostSetupScript } : {}),
      ...(claimedHostSetupCacheInputs.length
        ? { hostSetupCacheInputs: claimedHostSetupCacheInputs }
        : {}),
      ...(claimedHostSetupCacheHostInputs.length
        ? { hostSetupCacheHostInputs: claimedHostSetupCacheHostInputs }
        : {}),
      ...(claimedAllowedRoots.length ? { allowedRoots: claimedAllowedRoots } : {}),
      repository: claimedRepository,
      worktree: claimedWorktree,
      cwd,
      currentExecutionTarget: async () => {
        while (true) {
          const validationGeneration = this.inventoryGeneration;
          const roots = this.effectiveAllowedRoots();
          if (this.allowedRootsPolicyActive && roots.length === 0) {
            throw new Error(
              validationGeneration === generation
                ? "host inventory policy blocks execution"
                : "host inventory changed after this checkout was claimed",
            );
          }

          let targetRepository = claimedRepository;
          let targetWorktree = claimedWorktree;
          if (validationGeneration !== generation) {
            const currentRepository = this.config.repositories.find(
              (candidate) => candidate.id === claimedRepository.id,
            );
            const currentWorktree = currentRepository
              ? claimedWorktree.id === `main:${claimedRepository.id}`
                ? mainWorktree(currentRepository)
                : currentRepository.worktrees.find(
                    (candidate) => candidate.id === claimedWorktree.id,
                  )
              : undefined;
            if (
              !currentRepository ||
              !currentWorktree ||
              !sameOptionalString(claimedHostSetupScript, this.config.setupScript) ||
              !sameOptionalString(claimedRepository.setupScript, currentRepository.setupScript) ||
              !sameOptionalString(
                claimedRepository.terminalHookScript,
                currentRepository.terminalHookScript,
              ) ||
              !sameOptionalString(claimedWorktree.setupScript, currentWorktree.setupScript) ||
              !sameStrings(claimedHostSetupCacheInputs, this.config.setupCacheInputs ?? []) ||
              !sameStrings(
                claimedHostSetupCacheHostInputs,
                this.config.setupCacheHostInputs ?? [],
              ) ||
              !sameStrings(
                claimedRepository.setupCacheInputs ?? [],
                currentRepository.setupCacheInputs ?? [],
              ) ||
              !sameStrings(
                claimedWorktree.setupCacheInputs ?? [],
                currentWorktree.setupCacheInputs ?? [],
              ) ||
              !sameStrings(claimedAllowedRoots, roots)
            ) {
              throw new Error("host inventory changed after this checkout was claimed");
            }
            targetRepository = currentRepository;
            targetWorktree = currentWorktree;
          }

          const currentPaths = await assertClaimedPathsAllowed({
            cwd: targetWorktree.path,
            repositoryPath: targetRepository.path,
            terminalHookScript: targetRepository.terminalHookScript,
            allowedRoots: roots,
          });
          if (currentPaths.cwd !== cwd || currentPaths.repositoryPath !== paths.repositoryPath) {
            throw new Error("host inventory changed after this checkout was claimed");
          }
          if (validationGeneration === this.inventoryGeneration) return;
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
    if (this.allowedRootsPolicyActive && this.policyAllowedRoots.length === 0) {
      throw new Error("host inventory policy blocks execution");
    }
    return await assertClaimedPathsAllowed({
      cwd,
      repositoryPath: repository.path,
      terminalHookScript: repository.terminalHookScript,
      allowedRoots: this.effectiveAllowedRoots(),
    });
  }

  async claim(
    repositoryId: string,
    worktreeId: string,
    signal?: AbortSignal,
  ): Promise<ClaimedWorktree> {
    signal?.throwIfAborted();
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
    if (!this.isMaterialized(repositoryId, worktree)) {
      throw new Error(`Worktree not ready: ${worktreeId}`);
    }
    this.busy.add(worktreeId);
    try {
      while (true) {
        signal?.throwIfAborted();
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
          signal?.throwIfAborted();
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

  async mainClaim(repositoryId: string, signal?: AbortSignal): Promise<ClaimedWorktree> {
    while (true) {
      signal?.throwIfAborted();
      const generation = this.inventoryGeneration;
      const repository = this.config.repositories.find((r) => r.id === repositoryId);
      if (!repository) {
        if (generation !== this.inventoryGeneration) continue;
        throw new Error(`Unknown repository: ${repositoryId}`);
      }
      let paths: ClaimedPathsAllowed;
      try {
        paths = await this.assertClaimPaths(repository, repository.path);
        signal?.throwIfAborted();
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
    onWarning?: (message: string) => void,
  ): Promise<string | undefined> {
    await claimed.currentExecutionTarget?.();
    const target = ref ?? claimed.repository.defaultBranch;
    const baseline = await this.git.checkoutRef({
      cwd: claimed.cwd,
      repoPath: claimed.repository.path,
      ref: target,
      ...(signal ? { signal } : {}),
      ...(onWarning ? { onWarning } : {}),
    });
    return baseline && FULL_COMMIT_ID.test(baseline) ? baseline : undefined;
  }

  async prepareMainCheckout(
    claimed: ClaimedWorktree,
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    await claimed.currentExecutionTarget?.();
    const target = ref ?? claimed.repository.defaultBranch;
    await this.git.prepareMainCheckout({
      cwd: claimed.cwd,
      ref: target,
      ...(signal ? { signal } : {}),
    });
    const baseline = await this.git.revParse(claimed.cwd, "HEAD", signal).catch(() => undefined);
    return baseline && FULL_COMMIT_ID.test(baseline) ? baseline : undefined;
  }
}
