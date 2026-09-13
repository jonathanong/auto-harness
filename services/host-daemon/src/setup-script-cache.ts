import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { forEachDeclaredSetupFile } from "./setup-script-cache-file.ts";

export { readDeclaredSetupFiles } from "./setup-script-cache-file.ts";

export function defaultSetupCacheDir(home = homedir()): string {
  return join(home, ".auto-harness", "setup-cache");
}

export type SetupFingerprintParts = {
  checkoutSha: string;
  scripts: readonly string[];
  extraFiles: ReadonlyArray<{ path: string; contents: Buffer }>;
};

export type StoredSetupCache = {
  fingerprint: string;
  environment: NodeJS.ProcessEnv;
};

function writeLengthPrefixed(hash: ReturnType<typeof createHash>, value: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(value.length);
  hash.update(header);
  hash.update(value);
}

function startSetupFingerprint(
  checkoutSha: string,
  scripts: readonly string[],
  extraCount: number,
): ReturnType<typeof createHash> {
  const hash = createHash("sha256");
  writeLengthPrefixed(hash, Buffer.from("v1", "utf8"));
  writeLengthPrefixed(hash, Buffer.from(checkoutSha, "utf8"));
  writeLengthPrefixed(hash, Buffer.from(String(scripts.length)));
  for (const script of scripts) {
    writeLengthPrefixed(hash, Buffer.from(script, "utf8"));
  }
  writeLengthPrefixed(hash, Buffer.from(String(extraCount)));
  return hash;
}

function appendExtraFile(
  hash: ReturnType<typeof createHash>,
  path: string,
  contents: Buffer,
): void {
  writeLengthPrefixed(hash, Buffer.from(path, "utf8"));
  writeLengthPrefixed(hash, contents);
}

/** Stable digest of the operator-supplied inputs that may skip a later setup. */
export function fingerprintSetup(parts: SetupFingerprintParts): string {
  const hash = startSetupFingerprint(parts.checkoutSha, parts.scripts, parts.extraFiles.length);
  for (const extra of parts.extraFiles) {
    appendExtraFile(hash, extra.path, extra.contents);
  }
  return hash.digest("hex");
}

export function setupCacheFileName(worktreeId: string, cwd: string): string {
  return createHash("sha256").update(`${worktreeId}\0${cwd}`).digest("hex");
}

export function sanitizeCapturedSetupEnvironment(value: unknown): NodeJS.ProcessEnv | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && !key.toUpperCase().startsWith("HARNESS_")) {
      environment[key] = entry;
    }
  }
  return environment;
}

export async function readStoredSetupCache(
  cacheDir: string,
  worktreeId: string,
  cwd: string,
): Promise<StoredSetupCache | undefined> {
  try {
    const raw = await readFile(join(cacheDir, setupCacheFileName(worktreeId, cwd)), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const fingerprint = (parsed as { fingerprint?: unknown }).fingerprint;
    const environment = sanitizeCapturedSetupEnvironment(
      (parsed as { environment?: unknown }).environment,
    );
    if (typeof fingerprint !== "string" || fingerprint.length === 0 || !environment) {
      return undefined;
    }
    return { fingerprint, environment };
  } catch {
    return undefined;
  }
}

export async function writeStoredSetupCache(
  cacheDir: string,
  worktreeId: string,
  cwd: string,
  fingerprint: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const persisted: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string" && !key.toUpperCase().startsWith("HARNESS_")) {
      persisted[key] = value;
    }
  }
  await mkdir(cacheDir, { recursive: true });
  const file = join(cacheDir, setupCacheFileName(worktreeId, cwd));
  await writeFile(file, `${JSON.stringify({ fingerprint, environment: persisted })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600);
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
  signal?: AbortSignal;
}): Promise<
  { skip: true; environment: NodeJS.ProcessEnv } | { skip: false; fingerprintToStore?: string }
> {
  if (!input.cacheDir || !input.checkoutSha) return { skip: false };
  const hash = startSetupFingerprint(input.checkoutSha, input.scripts, input.extraPaths.length);
  const hashed = await forEachDeclaredSetupFile(
    input.cwd,
    input.extraPaths,
    (path, contents) => {
      appendExtraFile(hash, path, contents);
    },
    input.signal,
  );
  if (!hashed) return { skip: false };
  const fingerprint = hash.digest("hex");
  const stored = await readStoredSetupCache(input.cacheDir, input.worktreeId, input.cwd);
  if (!stored || stored.fingerprint !== fingerprint) {
    return { skip: false, fingerprintToStore: fingerprint };
  }
  return { skip: true, environment: stored.environment };
}
