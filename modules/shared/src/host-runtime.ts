/** Bounded, safe-to-display reason why checkout-recovery Git is unavailable. */
export const GIT_READINESS_REASONS = [
  "git_unavailable",
  "git_version_unparseable",
  "git_version_unsupported",
  "git_readiness_unreported",
] as const;

// Runtime reports include operator-allowlisted names plus baseline child-process
// names such as PATH, HOME, and LC_*. Keep this larger than the persisted
// requirement limit while still bounding registration payloads.
export const MAX_RUNTIME_ENVIRONMENT_NAMES = 512;
export const MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH = 128;

/** Windows child-process environment keys are case-insensitive; POSIX keys are not. */
export function environmentNamesAreCaseSensitive(platform: string): boolean {
  return platform !== "win32";
}

function boundedRuntimeText(candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128;
}

export type GitReadinessReason = (typeof GIT_READINESS_REASONS)[number];

/** Runtime facts reported by a modern daemon at registration time. */
export type HostRuntimeReport = {
  daemonVersion: string;
  gitVersion: string | null;
  gitReady: boolean;
  gitReadinessReason?: GitReadinessReason;
  /** Names available to repository child processes. Values never cross the daemon boundary. */
  environmentNames?: string[];
  /**
   * Whether names in `environmentNames` match child-process lookup case-sensitively.
   * Missing is a legacy report and preserves the POSIX-compatible exact-match behavior.
   */
  environmentNamesCaseSensitive?: boolean;
};

/** Validate untrusted runtime facts before they enter the durable host inventory. */
export function isHostRuntimeReport(value: unknown): value is HostRuntimeReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const runtime = value as Record<string, unknown>;
  if (
    !boundedRuntimeText(runtime.daemonVersion) ||
    (runtime.gitVersion !== null && !boundedRuntimeText(runtime.gitVersion)) ||
    typeof runtime.gitReady !== "boolean" ||
    (runtime.environmentNamesCaseSensitive !== undefined &&
      typeof runtime.environmentNamesCaseSensitive !== "boolean") ||
    (runtime.environmentNames !== undefined &&
      (!Array.isArray(runtime.environmentNames) ||
        runtime.environmentNames.length > MAX_RUNTIME_ENVIRONMENT_NAMES ||
        !runtime.environmentNames.every(
          (name) =>
            typeof name === "string" &&
            name.length > 0 &&
            name.length <= MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH,
        ) ||
        new Set(runtime.environmentNames).size !== runtime.environmentNames.length))
  )
    return false;
  if (runtime.gitReady)
    return runtime.gitVersion !== null && runtime.gitReadinessReason === undefined;
  return (
    typeof runtime.gitReadinessReason === "string" &&
    (GIT_READINESS_REASONS as readonly string[])
      .filter((reason) => reason !== "git_readiness_unreported")
      .includes(runtime.gitReadinessReason)
  );
}
