import { step } from "./host-smoke-format.js";
import { waitForSmokeSession } from "./host-smoke-poll.js";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates one session and waits for it. Inventory freshness is enforced by the daemon before it
 * acknowledges the assignment, so this client does not retry a terminal setup failure. A
 * `waitForSmokeSession` rejection (a genuine `getSession` failure — network error, 5xx — not a
 * `UsageLimitSignal`, which it already converts) fails only this provider. The created session's
 * id is deliberately left in `activeSessionIds` on that path so `teardownSmoke` retries cleanup.
 * Resolves to
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
      timeoutMs: timeoutSeconds * 1000,
      intervalMs,
      sleep,
      now,
      onStatus: (status) => io.stderr.write(`  session ${created.id}: ${status}\n`),
    });
  } catch (error) {
    return { kind: "session_wait_failed", sessionId: created.id, message: error.message };
  }
  if (outcome.kind === "terminal") activeSessionIds.delete(created.id);
  return { ...outcome, sessionId: created.id };
}
