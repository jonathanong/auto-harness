import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { isSetupCacheInputPath } from "@auto-harness/shared";

/** Upper bound for each operator-declared setup-cache extra file. */
export const MAX_SETUP_CACHE_INPUT_BYTES = 16 * 1024 * 1024;

function resolveDeclaredPath(cwd: string, relativePath: string): string | undefined {
  if (!isSetupCacheInputPath(relativePath)) return undefined;
  return join(cwd, ...relativePath.split("/"));
}

function openFlags(): number {
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

/** Open a bounded regular file. Symlinks, FIFOs, devices, and oversized files miss. */
export async function readBoundedRegularFile(
  path: string,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  if (signal?.aborted) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, openFlags());
    if (signal?.aborted) return undefined;
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_SETUP_CACHE_INPUT_BYTES) return undefined;
    const size = Number(st.size);
    const contents = Buffer.alloc(size);
    if (size === 0) return contents;
    if (signal?.aborted) return undefined;
    const { bytesRead } = await handle.read(contents, 0, size, 0);
    return contents.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function readDeclaredSetupFiles(
  cwd: string,
  relativePaths: readonly string[],
  signal?: AbortSignal,
): Promise<Array<{ path: string; contents: Buffer }> | undefined> {
  const extras: Array<{ path: string; contents: Buffer }> = [];
  for (const relativePath of relativePaths) {
    if (signal?.aborted) return undefined;
    const resolved = resolveDeclaredPath(cwd, relativePath);
    if (resolved === undefined) return undefined;
    const contents = await readBoundedRegularFile(resolved, signal);
    if (contents === undefined) return undefined;
    extras.push({ path: relativePath, contents });
  }
  return extras;
}
