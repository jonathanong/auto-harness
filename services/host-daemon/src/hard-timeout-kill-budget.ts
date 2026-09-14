/** Default POSIX SIGTERM-to-SIGKILL gap. Windows `taskkill /F` has no second stage. */
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;

type HardTimeoutKillBudget = {
  timeoutMs: number;
  terminationGraceMs?: number;
};

/**
 * Convert a hard timeout (process must be dead by this instant, including SIGKILL)
 * into SpawnProcessRunner timeout/grace.
 *
 * POSIX still SIGTERMs first when the budget allows a grace window. When less
 * than that grace remains, SIGTERM fires at the deadline and SIGKILL follows
 * immediately so settlement cannot outlive the lease. Windows uses one
 * forceful `taskkill /F` at the deadline and never schedules a second kill.
 */
export function hardTimeoutKillBudget(
  hardTimeoutMs: number,
  platform: NodeJS.Platform = process.platform,
  graceMs = DEFAULT_TERMINATION_GRACE_MS,
): HardTimeoutKillBudget {
  const timeoutMs = Math.max(0, hardTimeoutMs);
  if (platform === "win32") return { timeoutMs };
  if (timeoutMs <= graceMs) return { timeoutMs, terminationGraceMs: 0 };
  return { timeoutMs: timeoutMs - graceMs, terminationGraceMs: graceMs };
}
