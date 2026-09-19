import { AutoHarnessError } from "../../index.js";
import { pathSegment } from "../path-segment.js";
import { isDependencyConflict } from "./dependency-conflict.js";
import { detachRepository } from "./detach-repository.js";
import { step } from "./host-smoke-format.js";

// A dependency 409 here almost always means the worktree/host-inventory projection the delete
// guard reads (see services/api/src/control-plane-delete-guards.ts) hasn't caught up with the
// detach write this same teardown just made, or a just-cancelled session is still winding down
// — a few short retries clear both without a long wait. The same budget also covers a delete
// request that itself fails transiently (5xx, or a network/timeout error below the HTTP layer) —
// see `isTransientDeleteFailure` below.
const DELETE_ATTEMPTS = 5;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cancels every session still tracked as active — a per-provider timeout/usage-limit already
 * cancels its own session and untracks it (see `host-smoke-provider.js`); what is left here is
 * only the safety net for a session whose fate an unexpected exception left unresolved. Never
 * throws: a cancel failure is reported as a step, the id is kept (not deleted) in
 * `activeSessionIds`, and it comes back in `uncancelled` for the caller to report — a 409 means
 * the session raced to terminal on its own, which is fine to drop. */
async function cancelOutstanding(client, io, activeSessionIds) {
  const cancelled = [];
  const uncancelled = [];
  // Safe to delete the current entry mid-iteration (a Set only skips an entry deleted before
  // it is reached); nothing is added to the set during this loop.
  for (const sessionId of activeSessionIds) {
    try {
      await client.cancelSession(sessionId);
      cancelled.push(sessionId);
      activeSessionIds.delete(sessionId);
      step(io, true, `teardown: cancelled session ${sessionId}`);
    } catch (error) {
      if (error instanceof AutoHarnessError && error.status === 409) {
        cancelled.push(sessionId);
        activeSessionIds.delete(sessionId);
        step(io, true, `teardown: session ${sessionId} was already terminal`);
      } else {
        uncancelled.push(sessionId);
        step(io, false, `teardown: cancel session ${sessionId} failed: ${error.message}`);
      }
    }
  }
  return { cancelled, uncancelled };
}

/** True for a delete failure worth retrying beyond the existing dependency-409 case: an HTTP 5xx
 * (server-side, likely transient) or a rejection that never reached the HTTP layer at all (a
 * network error, or `AutoHarnessRequestTimeoutError`) — neither is `AutoHarnessError`'s own 4xx
 * shape, so both are retried like a 5xx. A 409 is intentionally *not* one of these: it is the
 * server definitively refusing (still has live dependents), not evidence the request itself may
 * have landed. */
function isTransientDeleteFailure(error) {
  return !(error instanceof AutoHarnessError) || error.status >= 500;
}

/** `DELETE /repositories/<id>`, retrying a dependency 409 or a transient failure
 * (`isTransientDeleteFailure`) a few times with a short backoff (`sleep` injected so tests never
 * really wait). Once a transient failure has actually happened, a later 404 is treated as success
 * — the delete most likely landed and the connection dropped before the response did — rather
 * than as a genuine "nothing to delete" failure, which a 404 with no prior transient failure
 * still is. Any other error, or the last attempt, is returned rather than thrown — teardown must
 * never throw (see its own doc comment). */
async function deleteRepositoryWithRetry(client, repositoryId, sleep) {
  let sawTransientFailure = false;
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
    try {
      await client.request(`/repositories/${pathSegment(repositoryId, "repositoryId")}`, {
        method: "DELETE",
      });
      return { ok: true };
    } catch (error) {
      const notFound = error instanceof AutoHarnessError && error.status === 404;
      if (sawTransientFailure && notFound) return { ok: true };
      const transient = isTransientDeleteFailure(error);
      if ((!transient && !isDependencyConflict(error)) || attempt === DELETE_ATTEMPTS) {
        return { ok: false, error };
      }
      if (transient) sawTransientFailure = true;
      await sleep(Math.min(250 * attempt, 2_000));
    }
  }
  /* v8 ignore next 2 -- the loop above always returns before falling out */
  return { ok: false, error: new Error("unreachable") };
}

/**
 * Runs from the caller's `finally`, no matter which earlier step failed or threw. Cancels any
 * session smoke created that never reached a terminal status on its own, detaches the
 * repository only if it was actually attached (an attach that itself threw never wrote
 * anything), then deletes the repository, retrying a dependency 409 or a transient failure a few
 * times. Never throws — a teardown failure is reported through its own `ok: false` result plus a
 * cleanup hint on stderr, so it always composes safely inside a `finally` (an exception thrown
 * from a `finally` would replace whatever error the `try` was already failing with). `ok` is
 * false whenever the repository is left behind (a failed detach or delete) **or** any session
 * failed to cancel — a still-live session blocks the delete guard, so an uncancelled session and
 * a leftover repository often go together, but each is reported (and each gets its own cleanup
 * command) independently of the other.
 */
export async function teardownSmoke({
  client,
  io,
  hostId,
  repositoryId,
  attached,
  activeSessionIds,
  sleep = defaultSleep,
}) {
  const { cancelled: cancelledSessionIds, uncancelled: uncancelledSessionIds } =
    await cancelOutstanding(client, io, activeSessionIds);

  let detached = false;
  let detachError;
  if (attached) {
    try {
      await detachRepository(client, hostId, repositoryId);
      detached = true;
      step(io, true, `teardown: detached repository ${repositoryId} from host ${hostId}`);
    } catch (error) {
      detachError = error;
      step(io, false, `teardown: detach repository ${repositoryId} failed: ${error.message}`);
    }
  }

  const deleteResult = await deleteRepositoryWithRetry(client, repositoryId, sleep);
  if (deleteResult.ok) {
    step(io, true, `teardown: deleted repository ${repositoryId}`);
  } else {
    step(
      io,
      false,
      `teardown: delete repository ${repositoryId} failed: ${deleteResult.error.message}`,
    );
  }

  const repositoryLeftover = Boolean(detachError) || !deleteResult.ok;
  const ok = !repositoryLeftover && uncancelledSessionIds.length === 0;
  if (!ok) {
    for (const sessionId of uncancelledSessionIds) {
      io.stderr.write(
        `leftover session ${sessionId} — finish cleanup with:\n` +
          `  auto-harness session cancel ${sessionId}\n`,
      );
    }
    if (repositoryLeftover) {
      io.stderr.write(
        `leftover repository ${repositoryId} — finish cleanup with:\n` +
          `  auto-harness host repo rm ${hostId} ${repositoryId}\n` +
          `  auto-harness repo rm ${repositoryId}\n`,
      );
    }
  }
  return {
    ok,
    cancelledSessionIds,
    uncancelledSessionIds,
    detached,
    repositoryDeleted: deleteResult.ok,
    ...(repositoryLeftover ? { leftoverRepositoryId: repositoryId } : {}),
  };
}
