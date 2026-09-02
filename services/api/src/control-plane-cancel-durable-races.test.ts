import { describe, expect, it } from "vitest";

import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const runningSession: SessionRecord = {
  id: "session",
  repositoryId: "repo",
  prompt: "run",
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T00:01:00.000Z",
  timeout: 30,
  priority: 0,
  requiredLabels: [],
  status: "running",
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  hostId: "host",
  worktreeId: "worktree",
};

describe("durable cancellation assignment fence", () => {
  it("does not cancel a running session whose observed assignment is incomplete", async () => {
    const state = createControlPlaneState();
    state.sessions.set(runningSession.id, { ...runningSession });
    setDurableReadStorage(state, { cancelRunningSession: async () => true });

    await expect(cancelSessionDurable(state, runningSession.id)).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });
  });

  it("notifies the host with the running attempt id", async () => {
    const state = createControlPlaneState();
    const notified: unknown[] = [];
    state.onHostMessage = (hostId, message) => void notified.push({ hostId, message });
    const session = {
      ...runningSession,
      assignmentConnectionId: "connection",
      attemptId: "attempt-1",
    };
    state.sessions.set(session.id, session);
    setDurableReadStorage(state, {
      getSession: async () => session,
      cancelRunningSession: async () => true,
    });
    await expect(cancelSessionDurable(state, session.id)).resolves.toMatchObject({ ok: true });
    expect(notified).toEqual([
      {
        hostId: "host",
        message: { type: "session:cancel", sessionId: "session", attemptId: "attempt-1" },
      },
    ]);
  });

  // The redelivery marker is no longer a separately-mockable `storage.recordPendingCancelRedelivery`
  // call at this layer: `cancelRunningSession`/`cancelRunningMainCheckoutSession` now write it inside
  // their own `TransactWriteCommand`, atomically with the session-cancel update (see
  // `writeCancelledSessionUpdate` in `db/plane-storage-session-cancel-write.ts`). That means a marker
  // write can no longer fail independently of the cancel itself — a failure there now fails the whole
  // transaction, which is the correct, tightened guarantee, not a preserved tolerance. Ordering
  // relative to the host notification is enforced by control flow (`await cancelRunningSession(...)`
  // precedes `state.onHostMessage?.(...)` in `cancelSessionDurable`), not by a mock assertion. The
  // atomic transaction's shape is covered by `db/plane-storage-session-cancel-write.test.ts` and
  // `db/dynamo-storage-sessions-defensive.test.ts`.
});
