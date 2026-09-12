import { mkdir, rm } from "node:fs/promises";

import {
  assertExistingDirectoryWithinAllowedRoots,
  assertDaemonPathsAllowed,
  assertPathWithinAllowedRoots,
  isWithinRoot,
} from "./allowed-roots.ts";
import type { DaemonConfig, WorkspacePoolConfig, WorkspaceSlotConfig } from "./config.ts";

type WorkspaceFs = {
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
};

const nodeFs: WorkspaceFs = {
  rm: async (path, options) => await rm(path, options),
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
};

export type ClaimedWorkspace = {
  pool: WorkspacePoolConfig;
  slot: WorkspaceSlotConfig;
  cwd: string;
  hostSetupScript?: string;
  allowedRoots: string[];
  currentExecutionTarget: () => Promise<void>;
};

/**
 * Owns the in-daemon serialization and destructive reset of host workspaces.
 * Unlike a worktree, a slot is intentionally not a Git checkout.
 */
export class WorkspaceManager {
  private readonly busy = new Set<string>();
  private readonly config: DaemonConfig;
  private readonly fs: WorkspaceFs;
  private policyRoots: string[] | undefined;
  private generation = 0;

  constructor(config: DaemonConfig, fs: WorkspaceFs = nodeFs) {
    this.config = config;
    this.fs = fs;
  }

  noteInventoryChange(): void {
    this.generation += 1;
  }

  setAllowedRootsPolicy(roots?: readonly string[]): void {
    this.policyRoots = roots ? [...roots] : [];
    this.noteInventoryChange();
  }

  clearAllowedRootsPolicy(): void {
    this.policyRoots = undefined;
    this.noteInventoryChange();
  }

  private roots(): string[] {
    return this.policyRoots === undefined ? (this.config.allowedRoots ?? []) : this.policyRoots;
  }

  private find(
    poolId: string,
    slotId: string,
  ): { pool: WorkspacePoolConfig; slot: WorkspaceSlotConfig } {
    const pool = this.config.workspacePools?.find(
      (candidate) => candidate.workspacePoolId === poolId,
    );
    if (!pool) throw new Error(`Unknown workspace pool: ${poolId}`);
    const slot = pool.slots.find((candidate) => candidate.id === slotId);
    if (!slot) throw new Error(`Unknown workspace slot: ${slotId}`);
    return { pool, slot };
  }

  private async checkedPath(path: string, roots = this.roots()): Promise<string> {
    // Workspace execution is never unrestricted: an omitted or emptied root policy
    // must fail before a destructive reset or process spawn.
    if (roots.length === 0) throw new Error("workspace sessions require non-empty allowedRoots");
    const checked = await assertPathWithinAllowedRoots(path, roots);
    // A root itself is too broad: cleanup recursively removes the workspace path.
    // Compare real paths so a spelling/symlink cannot turn a root into a child.
    const rootPaths = await Promise.all(
      roots.map(async (root) => {
        try {
          return await assertPathWithinAllowedRoots(root, roots);
        } catch {
          return null;
        }
      }),
    );
    if (rootPaths.some((root) => root !== null && root === checked)) {
      throw new Error(`workspace path must be a strict descendant of an allowed root: ${path}`);
    }
    // assertPathWithinAllowedRoots already rejects sibling volumes and parents. This
    // explicit check documents the destructive-operation invariant.
    if (
      !rootPaths.some((root) => root !== null && isWithinRoot(root, checked) && root !== checked)
    ) {
      throw new Error(`workspace path must be a strict descendant of an allowed root: ${path}`);
    }
    return await assertExistingDirectoryWithinAllowedRoots(checked, roots);
  }

  async ensureAll(candidate?: DaemonConfig): Promise<void> {
    const config = candidate ?? this.config;
    const pools = config.workspacePools ?? [];
    const roots = candidate === undefined ? this.roots() : (candidate.allowedRoots ?? []);
    await assertDaemonPathsAllowed({ ...config, allowedRoots: roots });
    for (const pool of pools)
      for (const slot of pool.slots) await this.checkedPath(slot.path, roots);
  }

  async claim(poolId: string, slotId: string, signal?: AbortSignal): Promise<ClaimedWorkspace> {
    signal?.throwIfAborted();
    const key = `${poolId}\0${slotId}`;
    if (this.busy.has(key)) throw new Error(`Workspace slot already busy: ${slotId}`);
    this.busy.add(key);
    try {
      const generation = this.generation;
      const { pool, slot } = this.find(poolId, slotId);
      const cwd = await this.checkedPath(slot.path);
      signal?.throwIfAborted();
      const roots = this.roots();
      return {
        pool,
        slot,
        cwd,
        ...(this.config.setupScript ? { hostSetupScript: this.config.setupScript } : {}),
        allowedRoots: [...roots],
        currentExecutionTarget: async () => {
          if (generation !== this.generation) {
            const current = this.find(poolId, slotId);
            if (current.slot.path !== slot.path) {
              throw new Error("host inventory changed after this workspace was claimed");
            }
          }
          let current: string;
          try {
            current = await this.checkedPath(slot.path);
          } catch (error) {
            if (generation !== this.generation) {
              throw new Error("host inventory changed after this workspace was claimed", {
                cause: error,
              });
            }
            throw error;
          }
          if (current !== cwd)
            throw new Error("host inventory changed after this workspace was claimed");
        },
      };
    } catch (error) {
      this.busy.delete(key);
      throw error;
    }
  }

  async destroyWorkspaceAfter(claimed: ClaimedWorkspace): Promise<void> {
    try {
      await claimed.currentExecutionTarget();
      // The canonical, checked path is used for both operations; never clean a
      // value supplied by the assignment frame.
      await this.fs.rm(claimed.cwd, { recursive: true, force: true });
      await this.fs.mkdir(claimed.cwd, { recursive: true });
      await claimed.currentExecutionTarget();
    } finally {
      this.busy.delete(`${claimed.pool.workspacePoolId}\0${claimed.slot.id}`);
    }
  }

  release(claimed: ClaimedWorkspace): void {
    this.busy.delete(`${claimed.pool.workspacePoolId}\0${claimed.slot.id}`);
  }
}
