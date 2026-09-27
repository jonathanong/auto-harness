const RECOVERY_CREDENTIAL_TIMEOUT_MS = 60_000;

export function recoveryDeadline(deadlineAtMs: number | undefined): {
  signal: AbortSignal;
  deadlineAtMs: number;
  dispose: () => void;
} {
  const controller = new AbortController();
  const deadline = Math.min(
    deadlineAtMs ?? Number.POSITIVE_INFINITY,
    Date.now() + RECOVERY_CREDENTIAL_TIMEOUT_MS,
  );
  const timeoutMs = deadline - Date.now();
  const timer = timeoutMs <= 0 ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  if (timeoutMs <= 0) controller.abort();
  return {
    signal: controller.signal,
    deadlineAtMs: deadline,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
