import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

import {
  DEFAULT_MAX_CONCURRENT_ASSIGNMENTS,
  MAX_CONCURRENT_ASSIGNMENTS_LIMIT,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_ACCOUNT_READINESS,
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

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  ctx: string,
): void {
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${ctx} has unknown key: ${unknown}`);
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
    const upper = key.toUpperCase();
    if (upper.startsWith("HARNESS_") || upper === "HOME" || upper === "USERPROFILE") {
      throw new Error(`${ctx} reserved name: ${key}`);
    }
    if (typeof value !== "string") throw new Error(`${ctx}.${key} must be a string`);
    env[key] = value;
  }
  return env;
}

function parseAccountProfile(providerAccountId: string, raw: unknown): ExecutionProfile {
  if (!providerAccountId) throw new Error("execution profile id must be a non-empty string");
  if (providerAccountId.length > MAX_PROVIDER_ACCOUNT_ID_LENGTH) {
    throw new Error(
      `execution profile id must be at most ${String(MAX_PROVIDER_ACCOUNT_ID_LENGTH)} characters`,
    );
  }
  if (!isRecord(raw)) throw new Error(`execution profile ${providerAccountId} must be an object`);
  rejectUnknownKeys(raw, ["home", "env"], `execution profile ${providerAccountId}`);
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
  rejectUnknownKeys(raw, ["maxConcurrentAssignments", "accounts"], "execution profiles");
  const maxConcurrentAssignments =
    raw.maxConcurrentAssignments === undefined
      ? DEFAULT_MAX_CONCURRENT_ASSIGNMENTS
      : parseAssignmentCap(raw.maxConcurrentAssignments, "maxConcurrentAssignments");
  const accounts = raw.accounts;
  if (accounts === undefined) return { maxConcurrentAssignments, profiles: new Map() };
  if (!isRecord(accounts)) throw new Error("execution profiles.accounts must be an object");
  const ids = Object.keys(accounts);
  if (ids.length > MAX_PROVIDER_ACCOUNT_READINESS) {
    throw new Error(
      `execution profiles.accounts must have at most ${String(MAX_PROVIDER_ACCOUNT_READINESS)} entries`,
    );
  }
  const profiles = new Map<string, ExecutionProfile>();
  const homes = new Set<string>();
  for (const providerAccountId of ids) {
    const profile = parseAccountProfile(providerAccountId, accounts[providerAccountId]);
    const home = normalize(profile.home);
    if (homes.has(home)) {
      throw new Error(`execution profile ${providerAccountId} reuses home ${home}`);
    }
    homes.add(home);
    profiles.set(providerAccountId, { ...profile, home });
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
    envKeys: Object.keys(profile.env).toSorted((left, right) => left.localeCompare(right)),
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
 *
 * HOME/USERPROFILE are set to the *resolved* home, not the configured path: a
 * single-operator host satisfies the home-uniqueness check with a symlink farm
 * (docs/host-daemon.md, "Single-operator host running every provider CLI under
 * one real account"), and at least one provider CLI's sandbox (codex's Seatbelt
 * profile) refuses to grant a writable root whose path has a symlink component.
 * Resolving here keeps the configured `home` (still distinct per account, still
 * what the uniqueness check and fingerprint operate on) while every spawned CLI
 * sees a real, symlink-free path.
 */
export function applyExecutionProfile(
  base: NodeJS.ProcessEnv,
  profile: ExecutionProfile,
  resolveHome: typeof realpathSync = realpathSync,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(profile.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("HARNESS_") || upper === "HOME" || upper === "USERPROFILE") continue;
    env[key] = value;
  }
  const resolvedHome = resolveHome(profile.home).toString();
  env.HOME = resolvedHome;
  env.USERPROFILE = resolvedHome;
  return env;
}
