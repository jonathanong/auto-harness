import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isAbsolutePathString } from "@auto-harness/shared";

import type { DaemonConfig } from "./config-types.ts";

export type RealpathFn = (path: string) => Promise<string>;
export type LstatFn = (path: string) => Promise<{ isSymbolicLink(): boolean }>;

/** Path primitives used by containment so Windows-style fixtures can inject `path.win32`. */
export type PathContainmentApi = {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  readonly sep: string;
};

const defaultPathApi: PathContainmentApi = { relative, isAbsolute, sep };

/**
 * Fail closed when `relative(root, candidate)` is another volume (`D:\secret` on Windows),
 * `..`, or a parent segment. A directory named `..hidden` under the root is inside.
 */
export function isWithinRoot(
  root: string,
  candidate: string,
  pathApi: PathContainmentApi = defaultPathApi,
): boolean {
  const rel = pathApi.relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(rel) &&
      !isAbsolutePathString(rel))
  );
}

/** Resolve a path that may not exist yet by realpath'ing the longest existing prefix. */
export async function resolvePathForRootCheck(
  path: string,
  realpathFn: RealpathFn = realpath,
  lstatFn: LstatFn = lstat,
): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const resolved = await realpathFn(current);
      return missing.length ? join(resolved, ...missing) : resolved;
    } catch (error) {
      let danglingSymlink = false;
      try {
        danglingSymlink = (await lstatFn(current)).isSymbolicLink();
      } catch {}
      if (danglingSymlink)
        throw new Error(`cannot resolve dangling symlink in path: ${current}`, { cause: error });
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

export function resolveHookPath(repositoryPath: string, terminalHookScript: string): string {
  return isAbsolute(terminalHookScript) || isAbsolutePathString(terminalHookScript)
    ? terminalHookScript
    : join(repositoryPath, terminalHookScript);
}

/** Re-check claimed cwd, repo path, and terminal hook immediately before use. */
export async function assertClaimedPathsAllowed(
  input: {
    cwd: string;
    repositoryPath: string;
    terminalHookScript?: string | undefined;
    allowedRoots?: readonly string[] | undefined;
  },
  realpathFn: RealpathFn = realpath,
): Promise<void> {
  const roots = input.allowedRoots ?? [];
  if (!roots.length) return;
  await assertPathWithinAllowedRoots(input.cwd, roots, realpathFn);
  await assertPathWithinAllowedRoots(input.repositoryPath, roots, realpathFn);
  if (input.terminalHookScript) {
    await assertPathWithinAllowedRoots(
      resolveHookPath(input.repositoryPath, input.terminalHookScript),
      roots,
      realpathFn,
    );
  }
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
        resolveHookPath(repository.path, repository.terminalHookScript),
        roots,
        realpathFn,
      );
    }
    for (const worktree of repository.worktrees) {
      await assertPathWithinAllowedRoots(worktree.path, roots, realpathFn);
    }
  }
}
