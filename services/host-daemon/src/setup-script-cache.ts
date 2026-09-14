import { homedir } from "node:os";
import { join } from "node:path";

import { forEachDeclaredSetupFile } from "./setup-script-cache-file.ts";
import {
  appendChildEnv,
  appendExtraFile,
  applyLiveEphemeralChildEnv,
  startSetupFingerprint,
} from "./setup-script-cache-hash.ts";
import { readStoredSetupCache } from "./setup-script-cache-store.ts";

export { readDeclaredSetupFiles } from "./setup-script-cache-file.ts";
export { fingerprintSetup } from "./setup-script-cache-hash.ts";
export {
  invalidateStoredSetupCache,
  readStoredSetupCache,
  sanitizeCapturedSetupEnvironment,
  setupCacheFileName,
  writeStoredSetupCache,
} from "./setup-script-cache-store.ts";

export function defaultSetupCacheDir(home = homedir()): string {
  return join(home, ".auto-harness", "setup-cache");
}

async function digestDeclaredInputs(input: {
  checkoutSha: string;
  cwd: string;
  scripts: readonly string[];
  extraPaths: readonly string[];
  hostPaths: readonly string[];
  childEnv?: NodeJS.ProcessEnv;
  appGeneratedGitHubConfigDir?: string;
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
  appendChildEnv(hash, input.childEnv, input.appGeneratedGitHubConfigDir);
  return hash.digest("hex");
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
  appGeneratedGitHubConfigDir?: string;
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
    ...(input.appGeneratedGitHubConfigDir
      ? { appGeneratedGitHubConfigDir: input.appGeneratedGitHubConfigDir }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!fingerprint) return { skip: false };
  const stored = await readStoredSetupCache(input.cacheDir, input.worktreeId, input.cwd);
  if (!stored || stored.fingerprint !== fingerprint) {
    return { skip: false, fingerprintToStore: fingerprint };
  }
  return {
    skip: true,
    environment: applyLiveEphemeralChildEnv(
      stored.environment,
      input.childEnv,
      input.appGeneratedGitHubConfigDir,
    ),
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
  appGeneratedGitHubConfigDir?: string;
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
    ...(input.appGeneratedGitHubConfigDir
      ? { appGeneratedGitHubConfigDir: input.appGeneratedGitHubConfigDir }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return fingerprint === input.expectedFingerprint ? fingerprint : undefined;
}
