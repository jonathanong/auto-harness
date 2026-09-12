import { mkdir, rm } from "node:fs/promises";

import {
  assertExistingDirectoryWithinAllowedRoots,
  assertDaemonPathsAllowed,
  assertPathWithinAllowedRoots,
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

type CheckedWorkspaceSlot = {
  poolId: string;
  slot: WorkspaceSlotConfig;
  checkedPath: string;
};

function workspacePathKey(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

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
  private inventoryUpdateInProgress = false;

  constructor(config: DaemonConfig, fs: WorkspaceFs = nodeFs) {
    this.config = config;
    this.fs = fs;
  }

  noteInventoryChange(): void {
    this.generation += 1;
  }

  /** Fence new claims while a candidate inventory is being validated and registered. */
  beginInventoryUpdate(): void {
    this.inventoryUpdateInProgress = true;
    this.noteInventoryChange();
  }

  /** Re-open claims after the candidate has either committed or been rolled back. */
  endInventoryUpdate(): void {
    this.inventoryUpdateInProgress = false;
    this.noteInventoryChange();
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

  private async checkedPath(
    path: string,
    roots: readonly string[] = this.roots(),
  ): Promise<string> {
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
    return await assertExistingDirectoryWithinAllowedRoots(checked, roots);
  }

  /** Reject a candidate that aliases a path still owned by a live claim. */
  private async assertBusyWorkspacePaths(
    candidate: readonly CheckedWorkspaceSlot[],
    roots: readonly string[],
  ): Promise<void> {
    const candidateByPath = new Map<string, CheckedWorkspaceSlot>();
    for (const slot of candidate) {
      candidateByPath.set(workspacePathKey(slot.checkedPath), slot);
    }
    for (const pool of this.config.workspacePools ?? []) {
      for (const slot of pool.slots) {
        if (!this.busy.has(`${pool.workspacePoolId}\0${slot.id}`)) continue;
        const sameIdentity = candidate.find(
          (next) => next.poolId === pool.workspacePoolId && next.slot.id === slot.id,
        );
        if (sameIdentity && sameIdentity.slot.path !== slot.path) {
          throw new Error(`cannot change the path of busy workspace slot: ${slot.id}`);
        }
        const currentPath = await this.checkedPath(slot.path, roots);
        const next = candidateByPath.get(workspacePathKey(currentPath));
        if (!next) continue;
        if (next.poolId === pool.workspacePoolId && next.slot.id === slot.id) {
          continue;
        }
        throw new Error(`workspace path aliases leased slot: ${slot.id}`);
      }
    }
  }

  async ensureAll(candidate?: DaemonConfig): Promise<void> {
    const config = candidate ?? this.config;
    const pools = config.workspacePools ?? [];
    const roots = candidate === undefined ? this.roots() : (candidate.allowedRoots ?? []);
    await assertDaemonPathsAllowed({ ...config, allowedRoots: roots });
    const checked = [] as CheckedWorkspaceSlot[];
    for (const pool of pools)
      for (const slot of pool.slots)
        checked.push({
          poolId: pool.workspacePoolId,
          slot,
          checkedPath: await this.checkedPath(slot.path, roots),
        });
    await this.assertBusyWorkspacePaths(checked, roots);
  }

  async claim(poolId: string, slotId: string, signal?: AbortSignal): Promise<ClaimedWorkspace> {
    signal?.throwIfAborted();
    if (this.inventoryUpdateInProgress) throw new Error("host inventory update in progress");
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
      // Use the canonical checked path for both operations, never the assignment frame value.
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
