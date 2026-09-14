import { opendir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { DaemonConfig } from "./config-types.ts";
import { setupCacheFileName } from "./setup-script-cache.ts";

/** Cap unlink attempts (success or failure) so a pathological cache cannot stall a tick. */
export const MAX_SETUP_CACHE_SWEEP_UNLINKS = 1024;
/** Cap opendir entries so a huge cache is not fully materialized in one tick. */
export const MAX_SETUP_CACHE_SWEEP_ENTRIES = 1024;
/** Delay before another bounded sweep after hitting a cap. */
export const SETUP_CACHE_SWEEP_RETRY_MS = 1_000;

const SETUP_CACHE_FILE_NAME = /^[0-9a-f]{64}$/;

function addLiveSetupCacheFileName(names: Set<string>, id: string, path: string): void {
  names.add(setupCacheFileName(id, path));
  const absolute = resolve(path);
  if (absolute !== path) names.add(setupCacheFileName(id, absolute));
}

/** True when a sidecar key still matches configured inventory (resolved and unresolved paths). */
export function isLiveSetupCacheFile(config: DaemonConfig, id: string, path: string): boolean {
  const live = liveSetupCacheFileNames(config);
  return live.has(setupCacheFileName(id, path));
}

/** Filenames that still match configured inventory, including scheduled main checkouts. */
export function liveSetupCacheFileNames(config: DaemonConfig): Set<string> {
  const names = new Set<string>();
  for (const repository of config.repositories) {
    addLiveSetupCacheFileName(names, `main:${repository.id}`, repository.path);
    for (const worktree of repository.worktrees) {
      addLiveSetupCacheFileName(names, worktree.id, worktree.path);
    }
  }
  for (const pool of config.workspacePools ?? []) {
    for (const slot of pool.slots) {
      addLiveSetupCacheFileName(names, slot.id, slot.path);
    }
  }
  return names;
}

async function addResolvedSetupCacheFileNames(
  names: Set<string>,
  config: DaemonConfig,
): Promise<void> {
  const add = async (id: string, path: string): Promise<void> => {
    try {
      names.add(setupCacheFileName(id, await realpath(path)));
    } catch {
      // Missing or unreadable paths are not live cache keys.
    }
  };
  for (const repository of config.repositories) {
    await add(`main:${repository.id}`, repository.path);
    for (const worktree of repository.worktrees) await add(worktree.id, worktree.path);
  }
  for (const pool of config.workspacePools ?? []) {
    for (const slot of pool.slots) await add(slot.id, slot.path);
  }
}

type SetupCacheSweepResult = {
  /** True when a cap stopped the walk before end-of-directory. */
  more: boolean;
};

/**
 * Delete setup-cache sidecars that no longer match inventory. Missing files and I/O
 * errors are ignored so expiry cannot fail a session or daemon start.
 */
export async function expireOrphanedSetupCache(
  cacheDir: string,
  config: DaemonConfig,
  options?: { maxUnlinks?: number; maxEntries?: number },
): Promise<SetupCacheSweepResult> {
  const maxUnlinks = options?.maxUnlinks ?? MAX_SETUP_CACHE_SWEEP_UNLINKS;
  const maxEntries = options?.maxEntries ?? MAX_SETUP_CACHE_SWEEP_ENTRIES;
  try {
    const live = liveSetupCacheFileNames(config);
    await addResolvedSetupCacheFileNames(live, config);
    const dir = await opendir(cacheDir);
    try {
      let examined = 0;
      let attempts = 0;
      while (examined < maxEntries && attempts < maxUnlinks) {
        const entry = await dir.read();
        if (!entry) return { more: false };
        examined += 1;
        if (entry.isDirectory() || !SETUP_CACHE_FILE_NAME.test(entry.name)) continue;
        if (live.has(entry.name)) continue;
        attempts += 1;
        try {
          await unlink(join(cacheDir, entry.name));
        } catch {
          // A busy or unreadable sidecar stays a future miss.
        }
      }
      return { more: (await dir.read()) !== null };
    } finally {
      try {
        await dir.close();
      } catch {
        // already closed or unreadable
      }
    }
  } catch {
    // Absent or unreadable cache directories are empty.
    return { more: false };
  }
}
