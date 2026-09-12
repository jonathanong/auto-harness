import { expect, it } from "vitest";

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
