import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  setupCacheFileName,
  signSetupCachePayload,
  verifySetupCachePayload,
} from "./setup-script-cache-mac.ts";

export { setupCacheFileName } from "./setup-script-cache-mac.ts";

type StoredSetupCache = {
  fingerprint: string;
  environment: NodeJS.ProcessEnv;
};

const SIDECAR_OPEN_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function sidecarPath(cacheDir: string, worktreeId: string, cwd: string): string {
  return join(cacheDir, setupCacheFileName(worktreeId, cwd));
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

function persistedSetupEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const persisted: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string" && !key.toUpperCase().startsWith("HARNESS_")) {
      persisted[key] = value;
    }
  }
  return persisted;
}

export async function readStoredSetupCache(
  cacheDir: string,
  worktreeId: string,
  cwd: string,
): Promise<StoredSetupCache | undefined> {
  try {
    const handle = await open(
      sidecarPath(cacheDir, worktreeId, cwd),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const raw = await handle.readFile("utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const fingerprint = (parsed as { fingerprint?: unknown }).fingerprint;
      const mac = (parsed as { mac?: unknown }).mac;
      const environment = sanitizeCapturedSetupEnvironment(
        (parsed as { environment?: unknown }).environment,
      );
      if (typeof fingerprint !== "string" || fingerprint.length === 0 || !environment) {
        return undefined;
      }
      if (typeof mac !== "string") return undefined;
      if (
        !verifySetupCachePayload({
          worktreeId,
          cwd,
          fingerprint,
          environment: persistedSetupEnvironment(environment),
          mac,
        })
      ) {
        return undefined;
      }
      return { fingerprint, environment };
    } finally {
      await handle.close();
    }
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
    await unlink(sidecarPath(cacheDir, worktreeId, cwd));
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
  const persisted = persistedSetupEnvironment(environment);
  const mac = signSetupCachePayload({
    worktreeId,
    cwd,
    fingerprint,
    environment: persisted,
  });
  await mkdir(cacheDir, { recursive: true });
  await chmod(cacheDir, 0o700).catch(() => undefined);
  const file = sidecarPath(cacheDir, worktreeId, cwd);
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(tmp, SIDECAR_OPEN_FLAGS, 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ fingerprint, environment: persisted, mac })}\n`,
      "utf8",
    );
    await handle.chmod(0o600);
    await handle.close();
    await rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await chmod(file, 0o600);
}
