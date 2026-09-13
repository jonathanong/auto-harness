import { readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { DaemonConfig } from "./config-types.ts";
import { setupCacheFileName } from "./setup-script-cache.ts";

/** Cap unlinks so a pathological cache directory cannot stall startup or inventory apply. */
const MAX_SETUP_CACHE_SWEEP_UNLINKS = 1024;

const SETUP_CACHE_FILE_NAME = /^[0-9a-f]{64}$/;

function addLiveSetupCacheFileName(names: Set<string>, id: string, path: string): void {
  names.add(setupCacheFileName(id, path));
  const absolute = resolve(path);
  if (absolute !== path) names.add(setupCacheFileName(id, absolute));
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

/**
 * Delete setup-cache sidecars that no longer match inventory. Missing files and I/O
 * errors are ignored so expiry cannot fail a session or daemon start.
 */
export async function expireOrphanedSetupCache(
  cacheDir: string,
  config: DaemonConfig,
  options?: { maxUnlinks?: number },
): Promise<void> {
  const maxUnlinks = options?.maxUnlinks ?? MAX_SETUP_CACHE_SWEEP_UNLINKS;
  try {
    const live = liveSetupCacheFileNames(config);
    await addResolvedSetupCacheFileNames(live, config);
    const entries = await readdir(cacheDir, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (removed >= maxUnlinks) break;
      if (entry.isDirectory() || !SETUP_CACHE_FILE_NAME.test(entry.name)) continue;
      if (live.has(entry.name)) continue;
      try {
        await unlink(join(cacheDir, entry.name));
        removed += 1;
      } catch {
        // A busy or unreadable sidecar stays a future miss.
      }
    }
  } catch {
    // Absent or unreadable cache directories are empty.
  }
}
