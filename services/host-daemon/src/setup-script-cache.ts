import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { isSetupCacheInputPath } from "@auto-harness/shared";

export function defaultSetupCacheDir(home = homedir()): string {
  return join(home, ".auto-harness", "setup-cache");
}

export type SetupFingerprintParts = {
  checkoutSha: string;
  scripts: readonly string[];
  extraFiles: ReadonlyArray<{ path: string; contents: Buffer }>;
};

function writeLengthPrefixed(hash: ReturnType<typeof createHash>, value: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(value.length);
  hash.update(header);
  hash.update(value);
}

/** Stable digest of the operator-supplied inputs that may skip a later setup. */
export function fingerprintSetup(parts: SetupFingerprintParts): string {
  const hash = createHash("sha256");
  writeLengthPrefixed(hash, Buffer.from("v1", "utf8"));
  writeLengthPrefixed(hash, Buffer.from(parts.checkoutSha, "utf8"));
  writeLengthPrefixed(hash, Buffer.from(String(parts.scripts.length)));
  for (const script of parts.scripts) {
    writeLengthPrefixed(hash, Buffer.from(script, "utf8"));
  }
  writeLengthPrefixed(hash, Buffer.from(String(parts.extraFiles.length)));
  for (const extra of parts.extraFiles) {
    writeLengthPrefixed(hash, Buffer.from(extra.path, "utf8"));
    writeLengthPrefixed(hash, extra.contents);
  }
  return hash.digest("hex");
}

export function setupCacheFileName(worktreeId: string, cwd: string): string {
  return createHash("sha256").update(`${worktreeId}\0${cwd}`).digest("hex");
}

function resolveDeclaredPath(cwd: string, relativePath: string): string | undefined {
  if (!isSetupCacheInputPath(relativePath)) return undefined;
  const resolved = join(cwd, ...relativePath.split("/"));
  const fromCwd = relative(cwd, resolved);
  if (fromCwd.startsWith("..") || isAbsolute(fromCwd) || fromCwd.split(sep).includes("..")) {
    return undefined;
  }
  return resolved;
}

export async function readDeclaredSetupFiles(
  cwd: string,
  relativePaths: readonly string[],
  read: (path: string) => Promise<Buffer> = readFile,
): Promise<Array<{ path: string; contents: Buffer }> | undefined> {
  const extras: Array<{ path: string; contents: Buffer }> = [];
  for (const relativePath of relativePaths) {
    const resolved = resolveDeclaredPath(cwd, relativePath);
    if (resolved === undefined) return undefined;
    try {
      extras.push({ path: relativePath, contents: await read(resolved) });
    } catch {
      return undefined;
    }
  }
  return extras;
}

export async function readStoredSetupFingerprint(
  cacheDir: string,
  worktreeId: string,
  cwd: string,
): Promise<string | undefined> {
  try {
    const file = join(cacheDir, setupCacheFileName(worktreeId, cwd));
    const digest = (await readFile(file, "utf8")).trim();
    return digest.length > 0 ? digest : undefined;
  } catch {
    return undefined;
  }
}

export async function writeStoredSetupFingerprint(
  cacheDir: string,
  worktreeId: string,
  cwd: string,
  fingerprint: string,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, setupCacheFileName(worktreeId, cwd)), `${fingerprint}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function mergeSetupCacheInputs(
  hostInputs: readonly string[] | undefined,
  scopedInputs: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const path of [...(hostInputs ?? []), ...(scopedInputs ?? [])]) {
    if (seen.has(path)) continue;
    seen.add(path);
    merged.push(path);
  }
  return merged;
}

export async function resolveSetupCacheState(input: {
  cacheDir: string | undefined;
  checkoutSha: string | undefined;
  cwd: string;
  worktreeId: string;
  scripts: readonly string[];
  extraPaths: readonly string[];
}): Promise<{ skip: boolean; fingerprintToStore?: string }> {
  if (!input.cacheDir || !input.checkoutSha) return { skip: false };
  const extraFiles = await readDeclaredSetupFiles(input.cwd, input.extraPaths);
  if (!extraFiles) return { skip: false };
  const fingerprint = fingerprintSetup({
    checkoutSha: input.checkoutSha,
    scripts: input.scripts,
    extraFiles,
  });
  const stored = await readStoredSetupFingerprint(input.cacheDir, input.worktreeId, input.cwd);
  return { skip: stored === fingerprint, fingerprintToStore: fingerprint };
}
