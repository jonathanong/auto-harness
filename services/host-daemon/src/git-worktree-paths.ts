import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** Best-effort canonicalization; keep lexical normalization for scripted or not-yet-created paths. */
export async function canonicalPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

/** Parse `git worktree list --porcelain` into canonicalized absolute paths (main checkout + linked). */
export async function listedWorktreePaths(output: string, repoPath: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const worktreePath = line.slice("worktree ".length);
    if (worktreePath.length > 0) {
      paths.add(await canonicalPath(resolve(repoPath, worktreePath)));
    }
  }
  return paths;
}
