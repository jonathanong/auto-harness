import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  DEFAULT_MAX_CONCURRENT_ASSIGNMENTS,
  MAX_CONCURRENT_ASSIGNMENTS_LIMIT,
  type ProviderAccountReadiness,
} from "@auto-harness/shared";

/** Daemon-local CLI home and extra environment for one provider account. */
export type ExecutionProfile = {
  providerAccountId: string;
  home: string;
  env: Record<string, string>;
};

export type ExecutionProfiles = {
  maxConcurrentAssignments: number;
  profiles: Map<string, ExecutionProfile>;
};

const EXECUTION_PROFILES_ENV = "HARNESS_EXECUTION_PROFILES";
const MAX_CONCURRENT_ASSIGNMENTS_ENV = "HARNESS_MAX_CONCURRENT_ASSIGNMENTS";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssignmentCap(value: unknown, ctx: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${ctx} must be a positive integer`);
  }
  if (value > MAX_CONCURRENT_ASSIGNMENTS_LIMIT) {
    throw new Error(`${ctx} must be at most ${String(MAX_CONCURRENT_ASSIGNMENTS_LIMIT)}`);
  }
  return value;
}

function parseProfileEnv(raw: unknown, ctx: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`${ctx} must be an object`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${ctx} has an invalid name`);
    }
    if (key.toUpperCase().startsWith("HARNESS_")) {
      throw new Error(`${ctx} reserved name: ${key}`);
    }
    if (typeof value !== "string") throw new Error(`${ctx}.${key} must be a string`);
    env[key] = value;
  }
  return env;
}

function parseAccountProfile(providerAccountId: string, raw: unknown): ExecutionProfile {
  if (!providerAccountId) throw new Error("execution profile id must be a non-empty string");
  if (!isRecord(raw)) throw new Error(`execution profile ${providerAccountId} must be an object`);
  if (typeof raw.home !== "string" || raw.home.length === 0 || !isAbsolute(raw.home)) {
    throw new Error(`execution profile ${providerAccountId}.home must be an absolute path`);
  }
  return {
    providerAccountId,
    home: raw.home,
    env: parseProfileEnv(raw.env, `execution profile ${providerAccountId}.env`),
  };
}

export function emptyExecutionProfiles(): ExecutionProfiles {
  return { maxConcurrentAssignments: DEFAULT_MAX_CONCURRENT_ASSIGNMENTS, profiles: new Map() };
}

/** Parse daemon-local profiles. Values never leave this process. */
export function parseExecutionProfiles(raw: unknown): ExecutionProfiles {
  if (raw === undefined || raw === null) return emptyExecutionProfiles();
  if (!isRecord(raw)) throw new Error("execution profiles must be an object");
  const maxConcurrentAssignments =
    raw.maxConcurrentAssignments === undefined
      ? DEFAULT_MAX_CONCURRENT_ASSIGNMENTS
      : parseAssignmentCap(raw.maxConcurrentAssignments, "maxConcurrentAssignments");
  const accounts = raw.accounts;
  if (accounts === undefined) return { maxConcurrentAssignments, profiles: new Map() };
  if (!isRecord(accounts)) throw new Error("execution profiles.accounts must be an object");
  const profiles = new Map<string, ExecutionProfile>();
  for (const [providerAccountId, profile] of Object.entries(accounts)) {
    profiles.set(providerAccountId, parseAccountProfile(providerAccountId, profile));
  }
  return { maxConcurrentAssignments, profiles };
}

export function loadExecutionProfiles(env: NodeJS.ProcessEnv = process.env): ExecutionProfiles {
  const parsed = env[MAX_CONCURRENT_ASSIGNMENTS_ENV]
    ? parseAssignmentCap(
        Number(env[MAX_CONCURRENT_ASSIGNMENTS_ENV]),
        MAX_CONCURRENT_ASSIGNMENTS_ENV,
      )
    : undefined;
  const path = env[EXECUTION_PROFILES_ENV];
  const loaded = path
    ? parseExecutionProfiles(JSON.parse(readFileSync(path, "utf8")) as unknown)
    : emptyExecutionProfiles();
  return parsed === undefined ? loaded : { ...loaded, maxConcurrentAssignments: parsed };
}

/** Opaque SHA-256 of home plus extra-env key names; values stay off the hash. */
export function executionProfileFingerprint(profile: ExecutionProfile): string {
  const canonical = JSON.stringify({
    home: profile.home,
    envKeys: Object.keys(profile.env).toSorted(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function executionProfileReady(
  profile: ExecutionProfile,
  exists: typeof existsSync = existsSync,
  stat: typeof statSync = statSync,
): boolean {
  if (!exists(profile.home)) return false;
  try {
    return stat(profile.home).isDirectory();
  } catch {
    return false;
  }
}

export function providerAccountReadiness(profiles: ExecutionProfiles): ProviderAccountReadiness[] {
  return [...profiles.profiles.values()]
    .map((profile) => ({
      providerAccountId: profile.providerAccountId,
      ready: executionProfileReady(profile),
      fingerprint: executionProfileFingerprint(profile),
    }))
    .toSorted((left, right) => left.providerAccountId.localeCompare(right.providerAccountId));
}

export function resolveExecutionProfile(
  profiles: ExecutionProfiles,
  providerAccountId: string | undefined,
): ExecutionProfile | undefined {
  if (!providerAccountId) return undefined;
  return profiles.profiles.get(providerAccountId);
}

/**
 * Overlay a profile's CLI home and extra env. Git/setup keep the daemon home;
 * callers apply this only to the assigned provider CLI.
 */
export function applyExecutionProfile(
  base: NodeJS.ProcessEnv,
  profile: ExecutionProfile,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: profile.home, USERPROFILE: profile.home };
  for (const [key, value] of Object.entries(profile.env)) {
    if (key.toUpperCase().startsWith("HARNESS_")) continue;
    env[key] = value;
  }
  return env;
}
