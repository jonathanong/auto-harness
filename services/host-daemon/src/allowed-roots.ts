import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isAbsolutePathString } from "@auto-harness/shared";

import type { DaemonConfig } from "./config-types.ts";

export type RealpathFn = (path: string) => Promise<string>;

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

/** Resolve a path that may not exist yet by realpath'ing the longest existing prefix. */
export async function resolvePathForRootCheck(
  path: string,
  realpathFn: RealpathFn = realpath,
): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const resolved = await realpathFn(current);
      return missing.length ? join(resolved, ...missing) : resolved;
    } catch (error) {
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export async function assertPathWithinAllowedRoots(
  path: string,
  allowedRoots: readonly string[],
  realpathFn: RealpathFn = realpath,
): Promise<string> {
  if (!allowedRoots.length) return path;
  if (!isAbsolute(path) && !isAbsolutePathString(path)) {
    throw new Error(`path must be absolute: ${path}`);
  }
  const resolved = await resolvePathForRootCheck(path, realpathFn);
  const roots: string[] = [];
  for (const root of allowedRoots) {
    try {
      roots.push(await realpathFn(root));
    } catch {
      // Missing roots cannot authorize a path.
    }
  }
  if (!roots.length) {
    throw new Error("no usable allowed roots");
  }
  if (roots.some((root) => isWithinRoot(root, resolved))) return resolved;
  throw new Error(`path is outside allowed roots: ${path}`);
}

function hookPath(repositoryPath: string, terminalHookScript: string): string {
  return isAbsolute(terminalHookScript) || isAbsolutePathString(terminalHookScript)
    ? terminalHookScript
    : join(repositoryPath, terminalHookScript);
}

/** Fail closed when exec-config names allowed roots the host cannot honor. */
export async function assertDaemonPathsAllowed(
  config: DaemonConfig,
  realpathFn: RealpathFn = realpath,
): Promise<void> {
  const roots = config.allowedRoots ?? [];
  if (!roots.length) return;
  for (const repository of config.repositories) {
    await assertPathWithinAllowedRoots(repository.path, roots, realpathFn);
    if (repository.terminalHookScript) {
      await assertPathWithinAllowedRoots(
        hookPath(repository.path, repository.terminalHookScript),
        roots,
        realpathFn,
      );
    }
    for (const worktree of repository.worktrees) {
      await assertPathWithinAllowedRoots(worktree.path, roots, realpathFn);
    }
  }
}
