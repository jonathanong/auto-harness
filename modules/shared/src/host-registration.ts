/** Minimal repository advertisement sent by a daemon during registration. */
export type HostRepositoryRegistration = {
  id: string;
  path: string;
  defaultBranch?: string;
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
