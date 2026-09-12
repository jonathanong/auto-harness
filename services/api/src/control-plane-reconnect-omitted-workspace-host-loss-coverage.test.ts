import { expect, it, vi } from "vitest";

import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./db/types.ts";

function workspaceSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    workspacePoolId: "pool",
    workspaceSlotId: "slot",
    workspaceSlotLease: true,
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2099-01-01T00:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    hostId: "host",
    worktreeId: null,
    attemptId: "attempt",
    ackReceivedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function busySlot(session: SessionRecord): WorkspaceSlotRecord {
  return {
    id: session.workspaceSlotId!,
    name: "slot",
    path: "/workspace/slot",
    hostId: "host",
    workspacePoolId: "pool",
    status: "busy",
    online: true,
    currentSessionId: session.id,
  };
}

it("atomically requeues a durable pre-launch workspace host loss", async () => {
  const state = createControlPlaneState();
  const session = workspaceSession({
    primaryCommandStartState: "pending",
    concurrencyId: "concurrency",
    hostAssignmentLease: { hostId: "host" },
  });
  const slot = busySlot(session);
  const finishSession = vi.fn(async () => true);
  state.sessions.set(session.id, session);
  state.storage = {
    getWorkspaceSlot: async () => slot,
    finishSession,
  } as never;

  await expect(
    reconcileHostOwnedSessions(state, "host", "connection", new Set(), "host omitted"),
  ).resolves.toEqual([session.id]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "queued",
      errorMessage: "host was lost before command launch; retrying once",
      infrastructureErrorCode: "host_lost",
      concurrencyId: "concurrency",
      hostAssignmentLease: { hostId: "host" },
    }),
  );
  expect(state.sessions.get(session.id)).toMatchObject({
    status: "queued",
    infrastructureRetryCount: 1,
    lastInfrastructureErrorCode: "host_lost",
  });
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});

it("atomically terminalizes a durable authorized workspace host loss", async () => {
  const state = createControlPlaneState({ now: () => "2026-01-01T00:01:00.000Z" });
  const session = workspaceSession({
    primaryCommandStartState: "authorized",
    infrastructureRetryCount: 1,
  });
  const slot = busySlot(session);
  const finishSession = vi.fn(async () => true);
  state.sessions.set(session.id, session);
  state.storage = {
    getWorkspaceSlot: async () => slot,
    finishSession,
  } as never;

  await expect(
    reconcileHostOwnedSessions(state, "host", "connection", new Set(), "host omitted"),
  ).resolves.toEqual([]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "failed",
      errorCode: "host_lost",
      errorMessage: "host lost after command authorization or retry exhaustion",
      completedAt: "2026-01-01T00:01:00.000Z",
    }),
  );
  expect(state.sessions.get(session.id)).toMatchObject({
    status: "failed",
    errorCode: "host_lost",
  });
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});

it("requeues a durable workspace omission before its assignment is acknowledged", async () => {
  const state = createControlPlaneState();
  const session = workspaceSession({ ackReceivedAt: undefined });
  const slot = busySlot(session);
  const finishSession = vi.fn(async () => true);
  state.sessions.set(session.id, session);
  state.storage = {
    getWorkspaceSlot: async () => slot,
    finishSession,
  } as never;

  await expect(
    reconcileHostOwnedSessions(state, "host", "connection", new Set(), "host omitted"),
  ).resolves.toEqual([session.id]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({ status: "queued", errorMessage: "host omitted" }),
  );
  expect(state.sessions.get(session.id)).toMatchObject({ status: "queued" });
});

it("keeps a durable workspace claim when its release fence loses", async () => {
  const state = createControlPlaneState();
  const session = workspaceSession({ primaryCommandStartState: "pending" });
  const slot = busySlot(session);
  state.sessions.set(session.id, session);
  state.storage = {
    getWorkspaceSlot: async () => slot,
    finishSession: async () => false,
  } as never;

  await expect(
    reconcileHostOwnedSessions(state, "host", "connection", new Set(), "host omitted"),
  ).resolves.toEqual([]);
  expect(state.sessions.get(session.id)).toBe(session);
  expect(state.workspaceSlots.has(slot.id)).toBe(false);
});
