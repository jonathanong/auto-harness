/** Bounded, safe-to-display reason why checkout-recovery Git is unavailable. */
export const GIT_READINESS_REASONS = [
  "git_unavailable",
  "git_version_unparseable",
  "git_version_unsupported",
  "git_readiness_unreported",
] as const;

export const MAX_RUNTIME_ENVIRONMENT_NAMES = 256;
export const MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH = 128;

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
};

/** Validate untrusted runtime facts before they enter the durable host inventory. */
export function isHostRuntimeReport(value: unknown): value is HostRuntimeReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const runtime = value as Record<string, unknown>;
  if (
    !boundedRuntimeText(runtime.daemonVersion) ||
    (runtime.gitVersion !== null && !boundedRuntimeText(runtime.gitVersion)) ||
    typeof runtime.gitReady !== "boolean" ||
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
