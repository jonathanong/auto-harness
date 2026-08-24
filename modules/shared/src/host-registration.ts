/** Minimal repository advertisement sent by a daemon during registration. */
export type HostRepositoryRegistration = {
  id: string;
  path: string;
  defaultBranch?: string;
};

/** In-flight assignment claimed on reconnect; fenced by attempt, not session alone. */
export type HostRunningAttempt = {
  sessionId: string;
  attemptId: string;
};

/**
 * Daemon-local execution-profile advertisement. Credentials and CLI homes never
 * leave the host; the control plane only sees readiness and an opaque hash.
 */
export type ProviderAccountReadiness = {
  providerAccountId: string;
  ready: boolean;
  fingerprint: string;
};

export const MAX_PROVIDER_ACCOUNT_READINESS = 256;
export const PROVIDER_ACCOUNT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Validate the non-worktree portion of a host registration advertisement. */
export function isHostRepositoryRegistration(value: unknown): value is HostRepositoryRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    (entry.defaultBranch === undefined ||
      (typeof entry.defaultBranch === "string" && entry.defaultBranch.length > 0))
  );
}

/** Reject duplicate repository IDs while retaining the daemon's ordering. */
export function validateHostRepositoryRegistrations(
  repositories: readonly HostRepositoryRegistration[],
): string | null {
  const seen = new Set<string>();
  for (const repository of repositories) {
    if (!isHostRepositoryRegistration(repository)) return "invalid repository registration";
    if (seen.has(repository.id)) return `duplicate repository ${repository.id}`;
    seen.add(repository.id);
  }
  return null;
}

export function isHostRunningAttempt(value: unknown): value is HostRunningAttempt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sessionId === "string" &&
    entry.sessionId.length > 0 &&
    typeof entry.attemptId === "string" &&
    entry.attemptId.length > 0
  );
}

/** Reject duplicate session IDs while retaining the daemon's ordering. */
export function validateHostRunningAttempts(
  attempts: readonly HostRunningAttempt[],
): string | null {
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (!isHostRunningAttempt(attempt)) return "invalid running attempt";
    if (seen.has(attempt.sessionId)) return `duplicate running session ${attempt.sessionId}`;
    seen.add(attempt.sessionId);
  }
  return null;
}

export function isProviderAccountReadiness(value: unknown): value is ProviderAccountReadiness {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.providerAccountId === "string" &&
    entry.providerAccountId.length > 0 &&
    entry.providerAccountId.length <= 512 &&
    typeof entry.ready === "boolean" &&
    typeof entry.fingerprint === "string" &&
    PROVIDER_ACCOUNT_FINGERPRINT_PATTERN.test(entry.fingerprint)
  );
}

/** Drop undeclared properties so homes, env, or credentials cannot persist. */
export function sanitizeProviderAccountReadiness(
  readiness: readonly ProviderAccountReadiness[],
): ProviderAccountReadiness[] {
  return readiness.map((entry) => ({
    providerAccountId: entry.providerAccountId,
    ready: entry.ready,
    fingerprint: entry.fingerprint,
  }));
}

/** Reject duplicate account IDs while retaining the daemon's ordering. */
export function validateProviderAccountReadiness(
  readiness: readonly ProviderAccountReadiness[],
): string | null {
  if (readiness.length > MAX_PROVIDER_ACCOUNT_READINESS) {
    return "too many provider account readiness entries";
  }
  const seen = new Set<string>();
  for (const entry of readiness) {
    if (!isProviderAccountReadiness(entry)) return "invalid provider account readiness";
    if (seen.has(entry.providerAccountId)) {
      return `duplicate provider account ${entry.providerAccountId}`;
    }
    seen.add(entry.providerAccountId);
  }
  return null;
}

/** Attempt-owned account leases use a namespace disjoint from caller lock IDs. */
export const PROVIDER_ACCOUNT_LEASE_PREFIX = "provider-lease:";

export function providerAccountLeaseConcurrencyId(providerAccountId: string, slot: number): string {
  return `${PROVIDER_ACCOUNT_LEASE_PREFIX}${providerAccountId}:${String(slot)}`;
}
