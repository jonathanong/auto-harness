/** Bounded, safe-to-display reason why checkout-recovery Git is unavailable. */
export const GIT_READINESS_REASONS = [
  "git_unavailable",
  "git_version_unparseable",
  "git_version_unsupported",
  "git_readiness_unreported",
] as const;

export type GitReadinessReason = (typeof GIT_READINESS_REASONS)[number];

/** Runtime facts reported by a modern daemon at registration time. */
export type HostRuntimeReport = {
  daemonVersion: string;
  gitVersion: string | null;
  gitReady: boolean;
  gitReadinessReason?: GitReadinessReason;
};
