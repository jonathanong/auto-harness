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
