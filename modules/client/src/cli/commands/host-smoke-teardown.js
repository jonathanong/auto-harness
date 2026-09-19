import { AutoHarnessError } from "../../index.js";
import { pathSegment } from "../path-segment.js";
import { isDependencyConflict } from "./dependency-conflict.js";
import { detachRepository } from "./detach-repository.js";
import { step } from "./host-smoke-format.js";

// A dependency 409 here almost always means the worktree/host-inventory projection the delete
// guard reads (see services/api/src/control-plane-delete-guards.ts) hasn't caught up with the
// detach write this same teardown just made, or a just-cancelled session is still winding down
// — a few short retries clear both without a long wait.
const DELETE_ATTEMPTS = 5;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cancels every session still tracked as active — a per-provider timeout/usage-limit already
 * cancels its own session and untracks it (see `host-smoke-provider.js`); what is left here is
 * only the safety net for a session whose fate an unexpected exception left unresolved. Never
 * throws: a cancel failure is reported as a step and left for the delete retry below to surface. */
async function cancelOutstanding(client, io, activeSessionIds) {
  const cancelled = [];
  // Safe to delete the current entry mid-iteration (a Set only skips an entry deleted before
  // it is reached); nothing is added to the set during this loop.
  for (const sessionId of activeSessionIds) {
    try {
      await client.cancelSession(sessionId);
      cancelled.push(sessionId);
      step(io, true, `teardown: cancelled session ${sessionId}`);
    } catch (error) {
      if (error instanceof AutoHarnessError && error.status === 409) {
        cancelled.push(sessionId);
        step(io, true, `teardown: session ${sessionId} was already terminal`);
      } else {
        step(io, false, `teardown: cancel session ${sessionId} failed: ${error.message}`);
      }
    }
    activeSessionIds.delete(sessionId);
  }
  return cancelled;
}

/** `DELETE /repositories/<id>`, retrying a dependency 409 a few times with a short backoff
 * (`sleep` injected so tests never really wait). Any other error, or the last attempt, is
 * returned rather than thrown — teardown must never throw (see its own doc comment). */
async function deleteRepositoryWithRetry(client, repositoryId, sleep) {
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
    try {
      await client.request(`/repositories/${pathSegment(repositoryId, "repositoryId")}`, {
        method: "DELETE",
      });
      return { ok: true };
    } catch (error) {
      if (!isDependencyConflict(error) || attempt === DELETE_ATTEMPTS) return { ok: false, error };
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
 * anything), then deletes the repository, retrying a dependency 409 a few times. Never throws —
 * a teardown failure is reported through its own `ok: false` result plus a leftover-repository
 * hint on stderr, so it always composes safely inside a `finally` (an exception thrown from a
 * `finally` would replace whatever error the `try` was already failing with).
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
  const cancelledSessionIds = await cancelOutstanding(client, io, activeSessionIds);

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

  const ok = !detachError && deleteResult.ok;
  if (!ok) {
    io.stderr.write(
      `leftover repository ${repositoryId} — finish cleanup with:\n` +
        `  auto-harness host repo rm ${hostId} ${repositoryId}\n` +
        `  auto-harness repo rm ${repositoryId}\n`,
    );
  }
  return {
    ok,
    cancelledSessionIds,
    detached,
    repositoryDeleted: deleteResult.ok,
    ...(ok ? {} : { leftoverRepositoryId: repositoryId }),
  };
}
