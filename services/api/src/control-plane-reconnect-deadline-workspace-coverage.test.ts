/* eslint-disable max-lines -- workspace reconnect-deadline branches share one fixture. */
import { expect, it, vi } from "vitest";

import {
  reclaimReconnectDeadlines,
  reconcileHostRunningSessions,
} from "./control-plane-reconnect.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./db/types.ts";

function reconnectingWorkspace(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    workspacePoolId: "pool",
    workspaceSlotId: "slot",
    workspaceSlotLease: true,
    prompt: "inspect",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: [],
    queueTtlSeconds: 300,
    queueExpiresAt: "later",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: "now",
    worktreeId: null,
    hostId: "host",
    attemptId: "attempt",
    ackReceivedAt: "now",
    primaryCommandStartState: "pending",
    reconnectDeadlineAt: "2000-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const slot: WorkspaceSlotRecord = {
  id: "slot",
  name: "slot",
  path: "/workspace",
  hostId: "host",
  workspacePoolId: "pool",
  status: "busy",
  online: false,
  currentSessionId: "session",
};

it("keeps a durable workspace session when its deadline transition has already been reclaimed", async () => {
  const state = createControlPlaneState();
  const session = reconnectingWorkspace({
    concurrencyId: "concurrency",
    hostAssignmentLease: { hostId: "host" },
  });
  const finishSession = vi.fn(async () => false);
  state.storage = {
    listAllSessions: async () => [session],
    getWorkspaceSlot: async () => slot,
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      concurrencyId: "concurrency",
      hostAssignmentLease: { hostId: "host" },
    }),
  );
  expect(state.sessions.has(session.id)).toBe(false);
});

it("leaves an expired durable workspace session alone when its advertised slot has disappeared", async () => {
  const state = createControlPlaneState();
  const session = reconnectingWorkspace();
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listAllSessions: async () => [session],
    getWorkspaceSlot: async () => null,
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(finishSession).not.toHaveBeenCalled();
  expect(state.sessions.has(session.id)).toBe(false);
});

it("leaves an expired durable workspace session alone after its host ownership is cleared", async () => {
  const state = createControlPlaneState();
  const session = reconnectingWorkspace({ hostId: null });
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listAllSessions: async () => [session],
    getWorkspaceSlot: async () => slot,
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(finishSession).not.toHaveBeenCalled();
  expect(state.sessions.has(session.id)).toBe(false);
});

it("does not reconcile durable reports after their host connection lease is gone", async () => {
  const state = createControlPlaneState();
  const getSession = vi.fn(async () => reconnectingWorkspace());
  state.storage = { getSession } as never;

  await expect(reconcileHostRunningSessions(state, "host", ["session"])).resolves.toEqual([]);
  expect(getSession).not.toHaveBeenCalled();
});

it("releases a cancelled durable workspace without queuing a new attempt", async () => {
  const state = createControlPlaneState();
  const cancelled = reconnectingWorkspace({ status: "cancelled", completedAt: "now" });
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listAllSessions: async () => [cancelled],
    getWorkspaceSlot: async () => slot,
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: cancelled.id,
      status: "cancelled",
      workspaceSlotId: slot.id,
    }),
  );
  expect(state.sessions.get(cancelled.id)).toMatchObject({
    status: "cancelled",
    workspaceSlotId: null,
    hostId: null,
  });
  expect(state.sessions.get(cancelled.id)).not.toHaveProperty("workspaceSlotLease");
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "idle",
    currentSessionId: null,
    online: false,
  });
});

it("rejects a reported workspace run that was never acknowledged", async () => {
  const state = createControlPlaneState();
  state.hostConnection.set("host", "connection");
  const session = reconnectingWorkspace({ ackReceivedAt: undefined });
  state.storage = {
    getSession: async () => session,
    getWorkspaceSlot: async () => slot,
  } as never;

  await expect(reconcileHostRunningSessions(state, "host", [session.id])).resolves.toBe(false);
});

it("reclaims local workspace deadlines and safely ignores a lease whose worktree id was lost", async () => {
  const state = createControlPlaneState();
  const workspace = reconnectingWorkspace();
  state.sessions.set(workspace.id, workspace);
  state.workspaceSlots.set(slot.id, slot);
  state.sessions.set(
    "missing-worktree",
    reconnectingWorkspace({
      id: "missing-worktree",
      workspaceSlotId: undefined,
      workspaceSlotLease: undefined,
      mainCheckoutLease: true,
      worktreeId: null,
    }),
  );

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([workspace.id]);
  expect(state.sessions.get(workspace.id)).toMatchObject({ status: "queued" });
  expect(state.sessions.get("missing-worktree")?.status).toBe("running");
});

it("releases a cancelled workspace only after reconnect grace expires", async () => {
  const state = createControlPlaneState();
  const cancelled = reconnectingWorkspace({ status: "cancelled", completedAt: "now" });
  state.sessions.set(cancelled.id, cancelled);
  state.workspaceSlots.set(slot.id, slot);

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(state.sessions.get(cancelled.id)).toMatchObject({
    status: "cancelled",
    workspaceSlotId: null,
  });
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "idle",
    currentSessionId: null,
    online: false,
  });
});

it("confirms a cancelled workspace that reconnects before grace expires", async () => {
  const state = createControlPlaneState();
  const cancelled = reconnectingWorkspace({
    status: "cancelled",
    completedAt: "now",
    reconnectDeadlineAt: "2999-01-01T00:00:00.000Z",
  });
  state.sessions.set(cancelled.id, cancelled);
  state.workspaceSlots.set(slot.id, slot);
  state.hostConnection.set("host", "replacement");

  await expect(reconcileHostRunningSessions(state, "host", [cancelled.id])).resolves.toEqual([]);
  expect(state.sessions.get(cancelled.id)).not.toHaveProperty("reconnectDeadlineAt");
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "busy",
    online: true,
    connectionId: "replacement",
  });
});

it("terminalizes an authorized workspace after reconnect grace instead of replaying it", async () => {
  const state = createControlPlaneState({ now: () => "2026-09-12T00:00:00.000Z" });
  const session = reconnectingWorkspace({ primaryCommandStartState: "authorized" });
  const finishSession = vi.fn(async () => true);
  state.sessions.set(session.id, session);
  state.workspaceSlots.set(slot.id, slot);
  state.storage = {
    listAllSessions: async () => [session],
    getWorkspaceSlot: async () => slot,
    getHostLock: async () => null,
    finishSession,
  } as never;

  await expect(
    reclaimReconnectDeadlines(state, Date.parse(session.reconnectDeadlineAt!)),
  ).resolves.toEqual([]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "failed",
      errorCode: "host_lost",
      errorMessage: "host lost after command authorization or retry exhaustion",
      workspaceSlotId: slot.id,
      expectedReconnectDeadlineAt: session.reconnectDeadlineAt,
    }),
  );
  expect(state.sessions.get(session.id)).toMatchObject({ status: "failed" });
  expect(state.sessions.get(session.id)).not.toHaveProperty("workspaceSlotId");
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});
