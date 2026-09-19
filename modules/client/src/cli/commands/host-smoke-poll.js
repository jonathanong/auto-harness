import { waitForSession } from "../wait-for-session.js";

/** Thrown from the wrapped `getSession` below to escape `waitForSession`'s loop the instant a
 * usage-limit requeue is observed, rather than waiting out the rest of `timeoutMs`. */
class UsageLimitSignal extends Error {
  constructor(session) {
    super("usage_limit");
    this.session = session;
  }
}

/** `client.getSession` wrapped to check *every* poll for `errorCode === "usage_limit"`, not
 * only a status *change* — see `waitForSmokeSession`'s doc comment for why that distinction
 * matters here. */
function usageLimitWatchedClient(client) {
  return {
    getSession: async (id) => {
      const session = await client.getSession(id);
      if (session.errorCode === "usage_limit") throw new UsageLimitSignal(session);
      return session;
    },
  };
}

/**
 * Wraps `waitForSession` so `host smoke` fails a provider fast when the control plane reports
 * `errorCode: "usage_limit"`, instead of sitting out the whole `--timeout`.
 * `session-transition-planner.ts`'s `planUsageLimit()` *requeues* a usage-limited session
 * (status goes back to `"queued"`, cooldown applied to the account) rather than failing it
 * outright, so a plain wait-for-terminal-status loop would never notice until the timeout
 * elapsed. This is checked on every single poll, not on `waitForSession`'s own `onStatus`
 * (which only fires on a status *change*) — a session that never even reaches `"running"`
 * (requeued immediately, or its account was already cooling down when created) gets
 * `errorCode` set with no status transition to hang the check off of.
 *
 * Throwing from the wrapped `getSession` — rather than from `onStatus` — rides a documented
 * part of `wait-for-session.js`'s own contract ("A `getSession` rejection ... propagates
 * as-is"), instead of relying on the undocumented fact that `onStatus` happens to run outside
 * a try/catch. `onStatus` itself is passed through untouched, still only for status-change
 * narration (e.g. to stderr).
 *
 * Resolves to `{ kind: "usage_limit", session }`, `{ kind: "timeout", session }`, or
 * `{ kind: "terminal", session }` — never rejects for a usage-limit signal; a genuine
 * `getSession` failure (network/API error) still propagates, exactly as `waitForSession` docs.
 */
export async function waitForSmokeSession(
  client,
  sessionId,
  { timeoutMs, intervalMs, sleep, now, onStatus },
) {
  try {
    const result = await waitForSession(usageLimitWatchedClient(client), sessionId, {
      timeoutMs,
      intervalMs,
      sleep,
      now,
      onStatus,
    });
    return { kind: result.timedOut ? "timeout" : "terminal", session: result.session };
  } catch (error) {
    if (error instanceof UsageLimitSignal) return { kind: "usage_limit", session: error.session };
    throw error;
  }
}

/** One-line diagnosis for a timed-out provider, keyed off the last observed status — see
 * `host-smoke.js`'s usage text and the README for the fuller explanation. */
export function timeoutHint(lastStatus) {
  if (lastStatus === "queued") {
    return (
      "session stayed queued — check that an online host advertises a ready execution " +
      "profile for this provider's account (HARNESS_EXECUTION_PROFILES), and that something " +
      "is running the scheduler (POST /scheduler/assign)"
    );
  }
  return `session was still ${lastStatus} when the timeout elapsed`;
}
