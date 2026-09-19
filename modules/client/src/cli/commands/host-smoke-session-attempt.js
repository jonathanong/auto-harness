import { step } from "./host-smoke-format.js";
import { waitForSmokeSession } from "./host-smoke-poll.js";

// A host's cached inventory only refreshes on its own periodic poll (there is no
// push-on-write) — see host-smoke-provider.js's doc comment for the full explanation. Five
// attempts of doubling backoff (2s, 4s, 8s, 16s, capped at 16s) covers the daemon's own
// default 15s poll at least once while staying well inside a generous --timeout.
const SETUP_FAILURE_RETRY_LIMIT = 5;
const SETUP_FAILURE_RETRY_BASE_MS = 2_000;
const SETUP_FAILURE_RETRY_MAX_MS = 16_000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for the one specific `setup_failed` shape thrown by
 * `services/host-daemon/src/worktree-manager.ts` when a host's own cached inventory hasn't
 * caught up with a just-attached repository yet. */
function isUnknownRepositorySetupFailure(session) {
  return (
    session.status === "failed" &&
    session.errorCode === "setup_failed" &&
    typeof session.errorMessage === "string" &&
    session.errorMessage.startsWith("Unknown repository:")
  );
}

/**
 * Creates a session and waits for it, retrying up to `SETUP_FAILURE_RETRY_LIMIT` times — with
 * exponential backoff, bounded by the same overall `timeoutSeconds` deadline as everything
 * else — but only for that one exact, unambiguous failure signature. Every other terminal shape
 * (a real setup/session failure, `usage_limit`, a genuine timeout, a `createSession` rejection)
 * returns immediately, unretried. A `waitForSmokeSession` rejection (a genuine `getSession`
 * failure — network error, 5xx — not a `UsageLimitSignal`, which it already converts) is caught
 * here too: it is not one of the narrow shapes above, and letting it propagate would abort every
 * remaining `--provider` in `host-smoke.js`'s loop and get misreported as a top-level
 * `setupError`. The created session's id is deliberately left in `activeSessionIds` (never
 * removed on this path) so `teardownSmoke`'s own safety net cancels it. Resolves to
 * `{ kind: "create_failed", message }`, `{ kind: "session_wait_failed", sessionId, message }`, or
 * `{ kind, session, sessionId }` where `kind` is `waitForSmokeSession`'s own
 * `"usage_limit" | "timeout" | "terminal"`.
 */
export async function runSessionAttempts({
  client,
  io,
  repositoryId,
  providerRef,
  target,
  marker,
  timeoutSeconds,
  activeSessionIds,
  sleep = defaultSleep,
  now = Date.now,
  intervalMs,
}) {
  const deadline = now() + timeoutSeconds * 1000;
  for (let attempt = 1; attempt <= SETUP_FAILURE_RETRY_LIMIT; attempt += 1) {
    let created;
    try {
      created = await client.createSession({
        repositoryId,
        prompt: `Reply with exactly: ${marker}`,
        target,
        timeout: timeoutSeconds,
      });
    } catch (error) {
      return { kind: "create_failed", message: error.message };
    }
    activeSessionIds.add(created.id);
    step(io, true, `provider ${providerRef}: created session ${created.id}`);

    let outcome;
    try {
      outcome = await waitForSmokeSession(client, created.id, {
        timeoutMs: Math.max(1, deadline - now()),
        intervalMs,
        sleep,
        now,
        onStatus: (status) => io.stderr.write(`  session ${created.id}: ${status}\n`),
      });
    } catch (error) {
      return { kind: "session_wait_failed", sessionId: created.id, message: error.message };
    }
    if (outcome.kind === "terminal") activeSessionIds.delete(created.id);

    const retryable =
      outcome.kind === "terminal" && isUnknownRepositorySetupFailure(outcome.session);
    const budgetMs = deadline - now();
    if (!retryable || attempt === SETUP_FAILURE_RETRY_LIMIT || budgetMs <= 0) {
      return { ...outcome, sessionId: created.id };
    }
    io.stderr.write(
      `  provider ${providerRef}: host has not picked up the newly attached repository yet ` +
        `(attempt ${attempt}/${SETUP_FAILURE_RETRY_LIMIT}); retrying\n`,
    );
    const backoffMs = Math.min(
      SETUP_FAILURE_RETRY_BASE_MS * 2 ** (attempt - 1),
      SETUP_FAILURE_RETRY_MAX_MS,
    );
    await sleep(Math.min(backoffMs, budgetMs));
  }
  /* v8 ignore next 2 -- the loop above always returns before falling out */
  return { kind: "create_failed", message: "unreachable" };
}
