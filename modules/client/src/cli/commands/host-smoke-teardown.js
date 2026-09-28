import { AutoHarnessError } from "../../index.js";
import { step } from "./host-smoke-format.js";

/** Only sessions created by this smoke run are eligible for cleanup. */
export async function teardownSmoke({ client, io, activeSessionIds }) {
  const cancelledSessionIds = [];
  const uncancelledSessionIds = [];
  for (const sessionId of activeSessionIds) {
    try {
      await client.cancelSession(sessionId);
      cancelledSessionIds.push(sessionId);
      activeSessionIds.delete(sessionId);
      step(io, true, `teardown: cancelled session ${sessionId}`);
    } catch (error) {
      if (error instanceof AutoHarnessError && error.status === 409) {
        cancelledSessionIds.push(sessionId);
        activeSessionIds.delete(sessionId);
        step(io, true, `teardown: session ${sessionId} was already terminal`);
      } else {
        uncancelledSessionIds.push(sessionId);
        step(io, false, `teardown: cancel session ${sessionId} failed: ${error.message}`);
      }
    }
  }
  for (const sessionId of uncancelledSessionIds) {
    io.stderr.write(
      `leftover session ${sessionId} — finish cleanup with:\n` +
        `  auto-harness session cancel ${sessionId}\n`,
    );
  }
  return {
    ok: uncancelledSessionIds.length === 0,
    cancelledSessionIds,
    uncancelledSessionIds,
  };
}
