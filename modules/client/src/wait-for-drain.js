import { AutoHarnessDrainWaitTimeoutError } from "./errors.js";

function drainPath(repositoryId, operationId) {
  return `/repositories/${encodeURIComponent(repositoryId)}/session-drains/${encodeURIComponent(operationId)}`;
}

/**
 * Polls a principal session drain until it leaves `"draining"`: an immediate first poll, then
 * `pollIntervalMs` between polls. Each individual poll is itself bounded by the shorter of
 * `client.requestTimeoutMs` and the remaining wait budget, so one hanging request cannot blow
 * past `timeoutMs` (a timed-out poll is not retried — it propagates as
 * `AutoHarnessRequestTimeoutError`). Once `timeoutMs` elapses without a terminal status, throws
 * `AutoHarnessDrainWaitTimeoutError`.
 */
export async function waitForSessionDrain(client, repositoryId, operationId, options) {
  const { pollIntervalMs, timeoutMs } = options ?? {};
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError("pollIntervalMs must be a finite positive number");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a finite positive number");
  }
  const path = drainPath(repositoryId, operationId);
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new AutoHarnessDrainWaitTimeoutError(repositoryId, operationId, timeoutMs);
    }
    result = await client.request(
      path,
      {},
      {
        timeoutMs: Math.max(1, Math.ceil(Math.min(client.requestTimeoutMs, remainingMs))),
      },
    );
    if (result.status === "draining") {
      const delayMs = Math.min(pollIntervalMs, deadline - Date.now());
      if (delayMs <= 0)
        throw new AutoHarnessDrainWaitTimeoutError(repositoryId, operationId, timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } while (result.status === "draining");
  return result;
}
