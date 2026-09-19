// Copied from `TERMINAL_SESSION_STATUSES` in modules/shared/src/constants.ts — this package is
// dependency-free (no `@auto-harness/shared` import), so the list is duplicated here rather than
// imported. Keep in sync if the shared list ever changes.
const TERMINAL_SESSION_STATUSES = ["completed", "failed", "cancelled", "timed_out"];

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `client.getSession(id)` until it reports a terminal status (see
 * `TERMINAL_SESSION_STATUSES` above), or until `timeoutMs` elapses while the session is still
 * active. The first fetch always happens, before the budget is even checked, so an
 * already-terminal session resolves correctly even with a tiny `timeoutMs`. `onStatus(status,
 * session)` fires once per *change* in status, including the first observed one — never on every
 * poll — so a caller can stream progress (e.g. to stderr) without duplicate lines.
 *
 * Resolves — never rejects on a timeout — to `{ timedOut: false, session }` once terminal, or
 * `{ timedOut: true, session }` (the last fetched, still-active record) once the budget elapses.
 * This never cancels the session itself; the caller decides what a timeout means. A `getSession`
 * rejection (a real API/network failure) propagates as-is.
 *
 * `sleep`/`now` are injectable so tests never really wait; `intervalMs` is clamped to the time
 * remaining before `timeoutMs` on the final poll.
 */
export async function waitForSession(
  client,
  id,
  { timeoutMs, intervalMs, sleep = defaultSleep, now = Date.now, onStatus } = {},
) {
  const deadline = now() + timeoutMs;
  let lastStatus;
  for (;;) {
    const session = await client.getSession(id);
    if (session.status !== lastStatus) {
      lastStatus = session.status;
      onStatus?.(session.status, session);
    }
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) {
      return { timedOut: false, session };
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { timedOut: true, session };
    await sleep(Math.min(intervalMs, remainingMs));
  }
}
