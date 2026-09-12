/* eslint-disable max-lines -- disconnect fencing cases share one storage fixture shape. */
import { expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { offlineHostAndRequeueDurableImpl } from "./control-plane-worktrees-disconnect.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./db/types.ts";

it("requeues a running workspace slot and takes the slot offline on durable disconnect", async () => {
  const state = createControlPlaneState({ now: () => "2026-09-12T00:00:00.000Z" });
  const session: SessionRecord = {
    id: "session",
    repositoryId: "",
    workspacePoolId: "pool",
    workspaceSlotId: "slot",
    workspaceSlotLease: true,
    prompt: "inspect",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: [],
    queueTtlSeconds: 300,
    queueExpiresAt: "2026-09-12T00:05:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: "2026-09-12T00:00:00.000Z",
    worktreeId: null,
    hostId: "host",
    attemptId: "attempt",
    assignmentConnectionId: "connection",
    hostAssignmentLease: { hostId: "host" },
  };
  const slot: WorkspaceSlotRecord = {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "host",
    workspacePoolId: "pool",
    status: "busy",
    online: true,
    currentSessionId: session.id,
    connectionId: "connection",
  };
  const writes: WorkspaceSlotRecord[] = [];
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    getSession: async () => session,
    getWorkspaceSlot: async () => slot,
    finishSession: async () => true,
    putWorkspaceSlot: async (next: WorkspaceSlotRecord) => {
      writes.push(next);
    },
    releaseLegacyHostAssignment: async () => true,
  } as never;

  await expect(
    offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []),
  ).resolves.toEqual([session.id]);
  expect(state.sessions.get(session.id)).toMatchObject({
    status: "queued",
    workspaceSlotId: null,
    hostId: null,
  });
  expect(writes).toEqual([expect.objectContaining({ id: slot.id, online: false })]);
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({ online: false });
});

it("holds an acknowledged workspace attempt through durable reconnect grace", async () => {
  const state = createControlPlaneState({
    now: () => "2026-09-12T00:00:00.000Z",
    reconnectGraceMs: 10_000,
  });
  const session = {
    id: "acknowledged",
    repositoryId: "",
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
    status: "running" as const,
    queueShard: 0,
    createdAt: "now",
    worktreeId: null,
    hostId: "host",
    attemptId: "attempt",
    ackReceivedAt: "now",
    assignmentConnectionId: "connection",
  };
  const slot: WorkspaceSlotRecord = {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "host",
    workspacePoolId: "pool",
    status: "busy",
    online: true,
    currentSessionId: session.id,
    connectionId: "connection",
  };
  const mark = vi.fn(async () => true);
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    getSession: async () => session,
    getWorkspaceSlot: async () => slot,
    putWorkspaceSlot: async () => undefined,
    markWorkspaceReconnectPending: mark,
  } as never;

  await expect(
    offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []),
  ).resolves.toEqual([]);
  expect(mark).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: session.id,
      workspaceSlotId: slot.id,
      connectionId: "connection",
    }),
  );
  expect(state.sessions.get(session.id)).toMatchObject({
    status: "running",
    workspaceSlotId: slot.id,
    reconnectDeadlineAt: "2026-09-12T00:00:10.000Z",
  });
  expect(state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "busy",
    currentSessionId: session.id,
    online: false,
  });
});

it("releases timeout-preserved workspace and host leases on durable disconnect", async () => {
  const state = createControlPlaneState();
  const session: SessionRecord = {
    id: "timed-out",
    repositoryId: "",
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
    status: "timed_out",
    queueShard: 0,
    createdAt: "now",
    completedAt: "later",
    worktreeId: null,
    hostId: null,
    timedOutHostId: "host",
    attemptId: "attempt",
    hostAssignmentLease: { hostId: "host" },
  };
  const slot: WorkspaceSlotRecord = {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "host",
    workspacePoolId: "pool",
    status: "busy",
    online: true,
    currentSessionId: session.id,
    connectionId: "connection",
  };
  const finishSession = vi.fn(async () => true);
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    getSession: async () => session,
    getWorkspaceSlot: async () => slot,
    finishSession,
    putWorkspaceSlot: async () => undefined,
  } as never;

  await offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []);

  expect(finishSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: session.id,
      expectedStatus: "timed_out",
      workspaceSlotId: slot.id,
      hostAssignmentLease: { hostId: "host" },
    }),
  );
  expect(finishSession.mock.calls[0]?.[0]).not.toHaveProperty("preserveWorkspaceSlotLease");
  expect(finishSession.mock.calls[0]?.[0]).not.toHaveProperty("preserveHostAssignmentLease");
  expect(state.sessions.get(session.id)).toMatchObject({
    status: "timed_out",
    workspaceSlotId: null,
    hostId: null,
  });
});

it("ignores workspace slots when durable slot storage is unavailable", async () => {
  for (const storage of [
    {},
    { listWorkspaceSlotsByHost: async () => [] },
    { listWorkspaceSlotsByHost: async () => [], getWorkspaceSlot: async () => null },
  ]) {
    const state = createControlPlaneState();
    state.storage = { listWorktreesByHost: async () => [], ...storage } as never;
    await expect(
      offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []),
    ).resolves.toEqual([]);
  }
});

it("fences stale slots and preserves or releases each durable session state", async () => {
  const state = createControlPlaneState();
  const baseSlot: WorkspaceSlotRecord = {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "host",
    workspacePoolId: "pool",
    status: "busy",
    online: true,
  };
  const baseSession: SessionRecord = {
    id: "session",
    repositoryId: "",
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
    status: "cancelled",
    queueShard: 0,
    createdAt: "now",
    worktreeId: null,
    hostId: "host",
    attemptId: "attempt",
    concurrencyId: "concurrency",
  };
  const slots = [
    { ...baseSlot, id: "stale", connectionId: "other" },
    { ...baseSlot, id: "empty", status: "idle" as const },
    { ...baseSlot, id: "completed", currentSessionId: "completed" },
    { ...baseSlot, id: "lost", currentSessionId: "lost" },
    { ...baseSlot, id: "cancelled", currentSessionId: "cancelled", connectionId: "connection" },
  ];
  const sessions = new Map<string, SessionRecord>([
    ["completed", { ...baseSession, id: "completed", status: "completed" }],
    ["lost", { ...baseSession, id: "lost", status: "running" }],
    ["cancelled", { ...baseSession, id: "cancelled" }],
  ]);
  const writes: WorkspaceSlotRecord[] = [];
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => slots,
    getSession: async (id: string) => sessions.get(id) ?? null,
    getWorkspaceSlot: async (id: string) =>
      id === "empty" ? null : slots.find((x) => x.id === id),
    finishSession: async ({ sessionId }: { sessionId: string }) => sessionId !== "lost",
    putWorkspaceSlot: async (slot: WorkspaceSlotRecord) => {
      writes.push(slot);
    },
  } as never;

  await expect(
    offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []),
  ).resolves.toEqual([]);
  expect(writes.map((slot) => slot.id)).toEqual(["empty", "completed", "cancelled"]);
  expect(state.sessions.get("cancelled")).toMatchObject({
    status: "cancelled",
    workspaceSlotId: null,
    hostId: null,
  });
});

it("does not take a replacement connection's workspace slot offline", async () => {
  const state = createControlPlaneState();
  const slot: WorkspaceSlotRecord = {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "host",
    workspacePoolId: "pool",
    status: "idle",
    online: true,
    connectionId: "old",
  };
  const replacement = { ...slot, connectionId: "new" };
  const putWorkspaceSlotFenced = vi.fn(async () => false);
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    getSession: async () => null,
    getWorkspaceSlot: async () => replacement,
    putWorkspaceSlot: async () => undefined,
    putWorkspaceSlotFenced,
  } as never;

  await expect(
    offlineHostAndRequeueDurableImpl(state, "host", "old", "offline", () => []),
  ).resolves.toEqual([]);
  expect(putWorkspaceSlotFenced).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: "new", online: false }),
    "old",
    "old",
  );
  expect(state.workspaceSlots.has(slot.id)).toBe(false);
});
