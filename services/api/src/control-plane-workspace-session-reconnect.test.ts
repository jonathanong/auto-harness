import { expect, it } from "vitest";

import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./db/types.ts";

it("fences durable omitted workspace-slot release to the current host connection", async () => {
  const state = createControlPlaneState({ now: () => "2026-09-12T00:00:00.000Z" });
  const session: SessionRecord = {
    id: "workspace-session",
    repositoryId: "",
    workspacePoolId: "pool-1",
    workspaceSlotId: "slot-1",
    workspaceSlotLease: true,
    prompt: "inspect",
    target: { commandId: "command-1" },
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
    hostId: "host-1",
    assignmentConnectionId: "connection-1",
    attemptId: "attempt-1",
    hostAssignmentLease: { hostId: "host-1" },
  };
  const slot: WorkspaceSlotRecord = {
    id: "slot-1",
    name: "one",
    path: "/srv/workspaces/one",
    hostId: "host-1",
    workspacePoolId: "pool-1",
    status: "busy",
    online: true,
    currentSessionId: session.id,
  };
  state.workspaceSlots.set(slot.id, slot);
  let finishOpts: Record<string, unknown> | undefined;
  state.storage = {
    listActiveSessionsByHost: async () => [session],
    getWorkspaceSlot: async () => slot,
    finishSession: async (opts: Record<string, unknown>) => {
      finishOpts = opts;
      return true;
    },
  } as never;

  await expect(
    reconcileHostOwnedSessions(
      state,
      "host-1",
      "connection-1",
      new Set(),
      "daemon no longer reports session as running; requeued",
    ),
  ).resolves.toEqual([session.id]);
  expect(finishOpts).toMatchObject({
    sessionId: session.id,
    workspaceSlotId: slot.id,
    worktreeId: null,
    expectedStatus: "running",
    fence: { hostId: "host-1", connectionId: "connection-1" },
    hostAssignmentLease: { hostId: "host-1" },
  });
});
