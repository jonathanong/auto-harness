import { AutoHarnessError, AutoHarnessRequestTimeoutError } from "auto-harness-client";

const DEFAULT_RETRY_DELAY_MS = 500;
// Bounds an honored Retry-After so one throttled response cannot hold a runner indefinitely.
const MAX_RETRY_DELAY_MS = 60_000;

// 408 and 429 are rejections before the request was acted on. A 5xx, a request timeout, or a
// dropped connection (fetch reports DNS/reset/refused as a bare TypeError) may follow a committed
// create or resume, so a blind retry could enqueue a second session.
function isRetryable(error: unknown, deduplicated: boolean): boolean {
  if (error instanceof AutoHarnessError) {
    const status = error.status ?? 0;
    return status === 408 || status === 429 || (deduplicated && status >= 500);
  }
  return (
    deduplicated && (error instanceof AutoHarnessRequestTimeoutError || error instanceof TypeError)
  );
}

export function retryDelayMs(retryAfter: string | undefined, now = Date.now()): number {
  if (!retryAfter) return DEFAULT_RETRY_DELAY_MS;
  const trimmed = retryAfter.trim();
  const delayMs = /^\d+$/.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(delayMs)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(Math.max(delayMs, 0), MAX_RETRY_DELAY_MS);
}

/**
 * Retries `request` once after a transient failure. Pass `deduplicated` only when the request
 * carries a concurrency identity the control plane deduplicates on; only then are ambiguous
 * failures retried. Each attempt is a fresh client call with its own request-timeout budget.
 */
export async function withRetry<T>(request: () => Promise<T>, deduplicated: boolean): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!isRetryable(error, deduplicated)) throw error;
    const retryAfter = error instanceof AutoHarnessError ? error.retryAfter : undefined;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(retryAfter)));
    return request();
  }
}
