import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { DaemonConfig } from "./config-types.ts";

type RealpathFn = (path: string) => Promise<string>;
type LstatFn = (path: string) => Promise<{ isSymbolicLink(): boolean }>;

/** Path primitives used by containment so Windows-style fixtures can inject `path.win32`. */
type PathContainmentApi = {
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
    rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel))
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
  if (!isAbsolute(path)) {
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

async function assertExistingPathWithinAllowedRoots(
  path: string,
  allowedRoots: readonly string[],
  realpathFn: RealpathFn,
): Promise<string> {
  const resolved = await assertPathWithinAllowedRoots(path, allowedRoots, realpathFn);
  try {
    return await realpathFn(resolved);
  } catch (error) {
    throw new Error(`terminal hook target does not exist: ${path}`, { cause: error });
  }
}

export function resolveHookPath(repositoryPath: string, terminalHookScript: string): string {
  // The control plane accepts both POSIX and Windows spellings because it cannot
  // know the host OS. Once a value reaches the daemon, however, a foreign
  // absolute spelling is ambiguous and must not be silently reinterpreted as a
  // relative filename (for example, C:\\hooks\\done.cmd on POSIX).
  if (isForeignWindowsAbsolutePath(terminalHookScript)) {
    throw new Error(
      `terminal hook path is not valid on ${process.platform}: ${terminalHookScript}`,
    );
  }
  return isAbsolute(terminalHookScript)
    ? terminalHookScript
    : join(repositoryPath, terminalHookScript);
}

export function isForeignWindowsAbsolutePath(path: string): boolean {
  return process.platform !== "win32" && (path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path));
}

export type ClaimedPathsAllowed = {
  cwd: string;
  repositoryPath: string;
  terminalHookScript?: string;
};

/** Re-check claimed cwd, repo path, and terminal hook immediately before use. */
export async function assertClaimedPathsAllowed(
  input: {
    cwd: string;
    repositoryPath: string;
    terminalHookScript?: string | undefined;
    allowedRoots?: readonly string[] | undefined;
  },
  realpathFn: RealpathFn = realpath,
): Promise<ClaimedPathsAllowed> {
  const roots = input.allowedRoots ?? [];
  if (!roots.length) {
    return {
      cwd: input.cwd,
      repositoryPath: input.repositoryPath,
      ...(input.terminalHookScript
        ? { terminalHookScript: resolveHookPath(input.cwd, input.terminalHookScript) }
        : {}),
    };
  }
  const cwd = await assertPathWithinAllowedRoots(input.cwd, roots, realpathFn);
  const repositoryPath = await assertPathWithinAllowedRoots(
    input.repositoryPath,
    roots,
    realpathFn,
  );
  if (!input.terminalHookScript) return { cwd, repositoryPath };
  const terminalHookScript = await assertExistingPathWithinAllowedRoots(
    resolveHookPath(cwd, input.terminalHookScript),
    roots,
    realpathFn,
  );
  return { cwd, repositoryPath, terminalHookScript };
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
      await assertExistingPathWithinAllowedRoots(
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
