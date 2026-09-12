import { describe, expect, it, vi } from "vitest";

import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { cancelSession } from "./control-plane-cancel-local.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";
import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repository",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("additional cancellation branch coverage", () => {
  it("locally cancels an unhosted running session without inventing a daemon message", () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:01:00.000Z" });
    const row = session({ status: "running", worktreeId: "worktree", attemptId: "attempt" });
    state.sessions.set(row.id, row);

    expect(cancelSession(state, row.id)).toMatchObject({
      ok: true,
      session: { status: "cancelled", hostId: null, worktreeId: null },
    });
  });

  it("cancels a main-checkout assignment with its exact durable lease fence", async () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:01:00.000Z" });
    const row = session({
      status: "running",
      hostId: "host",
      mainCheckoutLease: "main-checkout",
      assignmentConnectionId: "connection",
      attemptId: "attempt",
    });
    const cancelRunningMainCheckoutSession = vi.fn(async () => true);
    const messages: unknown[] = [];
    state.sessions.set(row.id, row);
    state.onHostMessage = (hostId, message) => void messages.push({ hostId, message });
    setDurableReadStorage(state, { getSession: async () => row, cancelRunningMainCheckoutSession });

    await expect(cancelSessionDurable(state, row.id)).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled", reconnectDeadlineAt: "2026-01-01T00:02:15.000Z" },
    });
    expect(cancelRunningMainCheckoutSession).toHaveBeenCalledWith({
      sessionId: row.id,
      hostId: "host",
      connectionId: "connection",
      attemptId: "attempt",
      queueShard: 2,
      completedAt: "2026-01-01T00:01:00.000Z",
      deadlineAt: "2026-01-01T00:02:15.000Z",
      errorMessage: "cancelled by operator",
    });
    expect(messages).toEqual([
      {
        hostId: "host",
        message: { type: "session:cancel", sessionId: row.id, attemptId: "attempt" },
      },
    ]);
  });

  it("preserves a main-checkout assignment when its durable cancellation loses", async () => {
    const state = createControlPlaneState();
    const row = session({
      status: "running",
      hostId: "host",
      mainCheckoutLease: "main-checkout",
      assignmentConnectionId: "connection",
      attemptId: "attempt",
    });
    state.sessions.set(row.id, row);
    setDurableReadStorage(state, {
      getSession: async () => row,
      cancelRunningMainCheckoutSession: async () => false,
    });

    await expect(cancelSessionDurable(state, row.id)).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });
    expect(state.sessions.get(row.id)).toMatchObject({
      status: "running",
      mainCheckoutLease: "main-checkout",
      attemptId: "attempt",
    });
  });

  it("passes queue concurrency and drain ownership through the durable cancel", async () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:01:00.000Z" });
    const row = session({ concurrencyId: "concurrency", principalId: "principal" });
    const cancelQueuedSession = vi.fn(async () => true);
    state.sessions.set(row.id, row);
    setDurableReadStorage(state, { getSession: async () => row, cancelQueuedSession });

    await expect(
      cancelSessionDurable(state, row.id, { drainOperationId: "drain" }),
    ).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });
    expect(state.sessions.get(row.id)?.cancelledByDrainOperationId).toBe("drain");
    expect(cancelQueuedSession).toHaveBeenCalledWith({
      sessionId: row.id,
      queueShard: 2,
      completedAt: "2026-01-01T00:01:00.000Z",
      errorMessage: "cancelled by operator",
      concurrencyId: "concurrency",
      drainOperationId: "drain",
      drainRepositoryId: "repository",
      drainPrincipalId: "principal",
    });
  });
});
