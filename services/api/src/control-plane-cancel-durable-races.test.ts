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
});
