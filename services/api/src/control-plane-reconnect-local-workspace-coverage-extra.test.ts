import { expect, it, vi } from "vitest";

import { reclaimReconnectDeadlines } from "./control-plane-reconnect.ts";
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

function busySlot(sessionId: string): WorkspaceSlotRecord {
  return {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "host",
    workspacePoolId: "pool",
    status: "busy",
    online: false,
    currentSessionId: sessionId,
  };
}

it("terminalizes an authorized local workspace attempt instead of replaying it", async () => {
  const state = createControlPlaneState({ now: () => "2026-09-12T00:00:00.000Z" });
  const session = reconnectingWorkspace({ primaryCommandStartState: "authorized" });
  state.sessions.set(session.id, session);
  state.workspaceSlots.set("slot", busySlot(session.id));

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(state.sessions.get(session.id)).toMatchObject({
    status: "failed",
    errorCode: "host_lost",
    errorMessage: "host lost after command authorization or retry exhaustion",
  });
  expect(state.sessions.get(session.id)).not.toHaveProperty("workspaceSlotId");
  expect(state.workspaceSlots.get("slot")).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});

it("requeues a pending local workspace attempt once after reconnect grace", async () => {
  const state = createControlPlaneState();
  const session = reconnectingWorkspace();
  state.sessions.set(session.id, session);
  state.workspaceSlots.set("slot", busySlot(session.id));

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([session.id]);
  expect(state.sessions.get(session.id)).toMatchObject({
    status: "queued",
    infrastructureRetryCount: 1,
    lastInfrastructureErrorCode: "host_lost",
    workspaceSlotId: null,
  });
});

it("requeues an unacknowledged local workspace attempt without calling it retry-safe", async () => {
  const state = createControlPlaneState();
  const session = reconnectingWorkspace({ ackReceivedAt: undefined });
  state.sessions.set(session.id, session);
  state.workspaceSlots.set("slot", busySlot(session.id));

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([session.id]);
  expect(state.sessions.get(session.id)).toMatchObject({ status: "queued" });
  expect(state.sessions.get(session.id)).not.toHaveProperty("lastInfrastructureErrorCode");
});

it("persists the retry disposition for a pending durable workspace attempt", async () => {
  const state = createControlPlaneState();
  const session = reconnectingWorkspace();
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listAllSessions: async () => [session],
    getWorkspaceSlot: async () => busySlot(session.id),
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([session.id]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "queued",
      errorMessage: "host was lost before command launch; retrying once",
      infrastructureErrorCode: "host_lost",
    }),
  );
});

it("persists the terminal disposition for an authorized durable workspace attempt", async () => {
  const state = createControlPlaneState({ now: () => "2026-09-12T00:00:00.000Z" });
  const session = reconnectingWorkspace({ primaryCommandStartState: "authorized" });
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listAllSessions: async () => [session],
    getWorkspaceSlot: async () => busySlot(session.id),
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "failed",
      errorMessage: "host lost after command authorization or retry exhaustion",
      errorCode: "host_lost",
    }),
  );
});

it("persists the ordinary reconnect disposition for an unacknowledged durable workspace", async () => {
  const state = createControlPlaneState();
  const session = reconnectingWorkspace({ ackReceivedAt: undefined });
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listAllSessions: async () => [session],
    getWorkspaceSlot: async () => busySlot(session.id),
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([session.id]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "queued",
      errorMessage: "daemon reconnect deadline exceeded; requeued",
    }),
  );
});

it("persists a terminal-hook handoff for an authorized durable main checkout", async () => {
  const state = createControlPlaneState({
    now: () => "2026-09-12T00:00:00.000Z",
    idFactory: () => "handoff",
  });
  const session = reconnectingWorkspace({
    workspaceSlotId: null,
    workspaceSlotLease: undefined,
    mainCheckoutLease: true,
    worktreeId: "worktree",
    primaryCommandStartState: "authorized",
  });
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listAllSessions: async () => [session],
    getWorktree: async () => ({
      id: "worktree",
      name: "worktree",
      path: "/repo/worktree",
      repositoryId: "repo",
      hostId: "host",
      labels: [],
      status: "busy",
      online: false,
      currentSessionId: session.id,
    }),
    getHostLock: async () => null,
    finishSession,
  } as never;

  await expect(reclaimReconnectDeadlines(state, Date.now())).resolves.toEqual([]);
  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "failed",
      terminalHookHandoff: expect.objectContaining({ handoffId: "handoff", hostId: "host" }),
    }),
  );
});
