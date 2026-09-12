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
