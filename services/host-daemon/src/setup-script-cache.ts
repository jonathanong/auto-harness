import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { forEachDeclaredSetupFile } from "./setup-script-cache-file.ts";
import {
  appendChildEnv,
  appendExtraFile,
  applyLiveEphemeralChildEnv,
  startSetupFingerprint,
} from "./setup-script-cache-hash.ts";

export { readDeclaredSetupFiles } from "./setup-script-cache-file.ts";
export { fingerprintSetup } from "./setup-script-cache-hash.ts";

export function defaultSetupCacheDir(home = homedir()): string {
  return join(home, ".auto-harness", "setup-cache");
}

export type StoredSetupCache = {
  fingerprint: string;
  environment: NodeJS.ProcessEnv;
};

async function digestDeclaredInputs(input: {
  checkoutSha: string;
  cwd: string;
  scripts: readonly string[];
  extraPaths: readonly string[];
  hostPaths: readonly string[];
  childEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const hash = startSetupFingerprint(
    input.checkoutSha,
    input.scripts,
    input.extraPaths.length + input.hostPaths.length,
  );
  const hashed = await forEachDeclaredSetupFile(
    input.cwd,
    input.extraPaths,
    (path, contents) => {
      appendExtraFile(hash, path, contents);
    },
    input.signal,
    input.hostPaths,
  );
  if (!hashed) return undefined;
  appendChildEnv(hash, input.childEnv);
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

/** Drop the sidecar after a command can mutate ignored worktree outputs. */
export async function invalidateStoredSetupCache(
  cacheDir: string | undefined,
  worktreeId: string,
  cwd: string,
): Promise<void> {
  if (!cacheDir) return;
  try {
    await unlink(join(cacheDir, setupCacheFileName(worktreeId, cwd)));
  } catch {
    // Missing or unreadable sidecars are already a miss.
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
  hostPaths?: readonly string[];
  childEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<
  { skip: true; environment: NodeJS.ProcessEnv } | { skip: false; fingerprintToStore?: string }
> {
  if (!input.cacheDir || !input.checkoutSha) return { skip: false };
  const fingerprint = await digestDeclaredInputs({
    checkoutSha: input.checkoutSha,
    cwd: input.cwd,
    scripts: input.scripts,
    extraPaths: input.extraPaths,
    hostPaths: input.hostPaths ?? [],
    ...(input.childEnv ? { childEnv: input.childEnv } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!fingerprint) return { skip: false };
  const stored = await readStoredSetupCache(input.cacheDir, input.worktreeId, input.cwd);
  if (!stored || stored.fingerprint !== fingerprint) {
    return { skip: false, fingerprintToStore: fingerprint };
  }
  return {
    skip: true,
    environment: applyLiveEphemeralChildEnv(stored.environment, input.childEnv),
  };
}

/** Rehash declared extras after setup. Changed bytes must not be stored as a hit. */
export async function matchingSetupFingerprintAfterSetup(input: {
  checkoutSha: string;
  cwd: string;
  scripts: readonly string[];
  extraPaths: readonly string[];
  hostPaths?: readonly string[];
  childEnv?: NodeJS.ProcessEnv;
  expectedFingerprint: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const fingerprint = await digestDeclaredInputs({
    checkoutSha: input.checkoutSha,
    cwd: input.cwd,
    scripts: input.scripts,
    extraPaths: input.extraPaths,
    hostPaths: input.hostPaths ?? [],
    ...(input.childEnv ? { childEnv: input.childEnv } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return fingerprint === input.expectedFingerprint ? fingerprint : undefined;
}
