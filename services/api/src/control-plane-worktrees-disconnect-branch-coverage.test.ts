import { expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { offlineHostAndRequeueDurableImpl } from "./control-plane-worktrees-disconnect.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./db/types.ts";

const slot: WorkspaceSlotRecord = {
  id: "slot",
  name: "slot",
  path: "/workspace",
  hostId: "host",
  workspacePoolId: "pool",
  status: "busy",
  online: true,
  currentSessionId: "session",
  connectionId: "connection",
};

const session: SessionRecord = {
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
};

it("refreshes neither cache when a workspace reconnect claim loses its race", async () => {
  const state = createControlPlaneState();
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    getSession: vi
      .fn(async () => session)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(null),
    getWorkspaceSlot: async () => null,
    markWorkspaceReconnectPending: async () => false,
    putWorkspaceSlot: async () => undefined,
  } as never;

  await expect(
    offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []),
  ).resolves.toEqual([]);
  expect(state.sessions.size).toBe(0);
  expect(state.workspaceSlots.size).toBe(0);
});

it("does not overwrite a slot when a fenced offline projection loses its race", async () => {
  const state = createControlPlaneState();
  const putWorkspaceSlotFenced = vi.fn(async () => false);
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [{ ...slot, currentSessionId: undefined }],
    getSession: async () => null,
    getWorkspaceSlot: async () => slot,
    putWorkspaceSlot: async () => undefined,
    putWorkspaceSlotFenced,
  } as never;

  await offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []);

  expect(putWorkspaceSlotFenced).toHaveBeenCalledWith(
    expect.objectContaining({ id: slot.id, online: false }),
    "connection",
    "connection",
  );
  expect(state.workspaceSlots.has(slot.id)).toBe(false);
});

it("refreshes both caches after a workspace reconnect claim loses its race", async () => {
  const state = createControlPlaneState();
  const latestSession = { ...session, reconnectDeadlineAt: undefined };
  const latestSlot = { ...slot, online: true };
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    getSession: vi
      .fn(async () => session)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(latestSession),
    getWorkspaceSlot: vi.fn(async () => latestSlot),
    markWorkspaceReconnectPending: async () => false,
    putWorkspaceSlot: async () => undefined,
  } as never;

  await offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []);

  expect(state.sessions.get(session.id)).toBe(latestSession);
  expect(state.workspaceSlots.get(slot.id)).toBe(latestSlot);
});

it("falls through to an offline projection when a retired slot's delete fence loses", async () => {
  const state = createControlPlaneState();
  const retired = { ...slot, retired: true, connectionId: undefined };
  const terminal = { ...session, status: "cancelled" as const, ackReceivedAt: undefined };
  const deleteRetiredWorkspaceSlotIfIdle = vi.fn(async () => false);
  const putWorkspaceSlot = vi.fn(async () => undefined);
  state.workspaceSlots.set(retired.id, { ...retired, currentSessionId: null });
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [retired],
    getSession: async () => terminal,
    getWorkspaceSlot: async () => retired,
    finishSession: async () => true,
    deleteRetiredWorkspaceSlotIfIdle,
    putWorkspaceSlot,
  } as never;

  await offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []);

  expect(deleteRetiredWorkspaceSlotIfIdle).toHaveBeenCalledWith(retired.id);
  expect(putWorkspaceSlot).toHaveBeenCalledWith(expect.objectContaining({ online: false }));
});

it("removes a retired slot after its terminal session is released", async () => {
  const state = createControlPlaneState();
  const retired = { ...slot, retired: true, connectionId: undefined };
  const terminal = { ...session, status: "cancelled" as const, ackReceivedAt: undefined };
  const deleteRetiredWorkspaceSlotIfIdle = vi.fn(async () => true);
  const putWorkspaceSlotFenced = vi.fn(async () => true);
  state.workspaceSlots.set(retired.id, { ...retired, currentSessionId: null });
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [retired],
    getSession: async () => terminal,
    getWorkspaceSlot: async () => retired,
    finishSession: async () => true,
    deleteRetiredWorkspaceSlotIfIdle,
    putWorkspaceSlot: async () => undefined,
    putWorkspaceSlotFenced,
  } as never;

  await offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []);

  expect(deleteRetiredWorkspaceSlotIfIdle).toHaveBeenCalledWith(retired.id);
  expect(putWorkspaceSlotFenced).not.toHaveBeenCalled();
});

it("fences an idle slot without an expected prior connection", async () => {
  const state = createControlPlaneState();
  const idle = {
    ...slot,
    status: "idle" as const,
    currentSessionId: null,
    connectionId: undefined,
  };
  const putWorkspaceSlotFenced = vi.fn(async () => true);
  state.storage = {
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [idle],
    getSession: async () => null,
    getWorkspaceSlot: async () => idle,
    putWorkspaceSlot: async () => undefined,
    putWorkspaceSlotFenced,
  } as never;

  await offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []);

  expect(putWorkspaceSlotFenced).toHaveBeenCalledWith(
    expect.objectContaining({ online: false }),
    "connection",
    undefined,
  );
});
