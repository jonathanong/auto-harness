import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { isSetupCacheInputPath } from "@auto-harness/shared";

/** Upper bound for each operator-declared setup-cache extra file, and for their aggregate. */
export const MAX_SETUP_CACHE_INPUT_BYTES = 16 * 1024 * 1024;

export type SetupCacheReadableHandle = {
  read(
    buffer: NodeJS.ArrayBufferView,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number }>;
};

function resolveDeclaredPath(cwd: string, relativePath: string): string | undefined {
  if (!isSetupCacheInputPath(relativePath)) return undefined;
  return join(cwd, ...relativePath.split("/"));
}

function openFlags(): number {
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

/** Loop until `size` bytes arrive. A premature 0-byte read or abort is a cache miss. */
export async function readFileHandleCompletely(
  handle: SetupCacheReadableHandle,
  size: number,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const contents = Buffer.alloc(size);
  if (size === 0) return contents;
  let offset = 0;
  while (offset < size) {
    if (signal?.aborted) return undefined;
    const { bytesRead } = await handle.read(contents, offset, size - offset, offset);
    if (bytesRead === 0) return undefined;
    offset += bytesRead;
  }
  return contents;
}

/** Open a bounded regular file. Symlinks, FIFOs, devices, and oversized files miss. */
export async function readBoundedRegularFile(
  path: string,
  signal?: AbortSignal,
  maxBytes = MAX_SETUP_CACHE_INPUT_BYTES,
): Promise<Buffer | undefined> {
  if (signal?.aborted) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, openFlags());
    if (signal?.aborted) return undefined;
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_SETUP_CACHE_INPUT_BYTES || st.size > maxBytes) {
      return undefined;
    }
    const size = Number(st.size);
    if (size === 0) return Buffer.alloc(0);
    if (signal?.aborted) return undefined;
    return await readFileHandleCompletely(handle, size, signal);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** Hash each declared extra as it is read, then drop the buffer. Aggregate over 16 MiB misses. */
export async function forEachDeclaredSetupFile(
  cwd: string,
  relativePaths: readonly string[],
  onFile: (relativePath: string, contents: Buffer) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  let remaining = MAX_SETUP_CACHE_INPUT_BYTES;
  for (const relativePath of relativePaths) {
    if (signal?.aborted) return false;
    const resolved = resolveDeclaredPath(cwd, relativePath);
    if (resolved === undefined) return false;
    const contents = await readBoundedRegularFile(resolved, signal, remaining);
    if (contents === undefined) return false;
    remaining -= contents.length;
    onFile(relativePath, contents);
  }
  return true;
}

export async function readDeclaredSetupFiles(
  cwd: string,
  relativePaths: readonly string[],
  signal?: AbortSignal,
): Promise<Array<{ path: string; contents: Buffer }> | undefined> {
  const extras: Array<{ path: string; contents: Buffer }> = [];
  const ok = await forEachDeclaredSetupFile(
    cwd,
    relativePaths,
    (path, contents) => {
      extras.push({ path, contents });
    },
    signal,
  );
  return ok ? extras : undefined;
}
