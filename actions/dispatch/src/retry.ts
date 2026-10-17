import { AutoHarnessError, AutoHarnessRequestTimeoutError } from "auto-harness-client";

const DEFAULT_RETRY_DELAY_MS = 500;
// Bounds an honored Retry-After so one throttled response cannot hold a runner indefinitely.
const MAX_RETRY_DELAY_MS = 60_000;

function isRetryable(error: unknown): boolean {
  if (error instanceof AutoHarnessRequestTimeoutError) return true;
  if (error instanceof AutoHarnessError) {
    const status = error.status ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
  // fetch reports connection failures (DNS, reset, refused) as a bare TypeError.
  return error instanceof TypeError;
}

export function retryDelayMs(retryAfter: string | undefined, now = Date.now()): number {
  if (!retryAfter) return DEFAULT_RETRY_DELAY_MS;
  const trimmed = retryAfter.trim();
  const delayMs = /^\d+$/.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(delayMs)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(Math.max(delayMs, 0), MAX_RETRY_DELAY_MS);
}

/**
 * Retries `request` once after a transient failure (408, 429, 5xx, request timeout, or network
 * error). Each attempt is a fresh client call, so it gets its own request-timeout budget.
 */
export async function withRetry<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!isRetryable(error)) throw error;
    const retryAfter = error instanceof AutoHarnessError ? error.retryAfter : undefined;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(retryAfter)));
    return request();
  }
}
