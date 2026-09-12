import { expect, it } from "vitest";

import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./db/types.ts";

function workspaceSession(id: string): SessionRecord {
  return {
    id,
    repositoryId: "",
    workspacePoolId: "pool",
    workspaceSlotId: `slot-${id}`,
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
  };
}

it("uses the durable active-session cache fallback and keeps a slot claimed after a lost release", async () => {
  const state = createControlPlaneState();
  const lost = workspaceSession("lost");
  const released = workspaceSession("released");
  const slots = new Map<string, WorkspaceSlotRecord>(
    [lost, released].map((session) => [
      session.workspaceSlotId!,
      {
        id: session.workspaceSlotId!,
        name: session.workspaceSlotId!,
        path: `/workspace/${session.id}`,
        hostId: "host",
        workspacePoolId: "pool",
        status: "busy",
        online: true,
        currentSessionId: session.id,
      },
    ]),
  );
  state.sessions.set(lost.id, lost);
  state.sessions.set(released.id, released);
  state.storage = {
    getWorkspaceSlot: async (id: string) => slots.get(id) ?? null,
    finishSession: async (opts: { sessionId: string }) => opts.sessionId === released.id,
  } as never;

  await expect(
    reconcileHostOwnedSessions(state, "host", "connection", new Set(), "omitted"),
  ).resolves.toEqual([released.id]);
  expect(state.sessions.get(lost.id)?.status).toBe("running");
  expect(state.sessions.get(released.id)).toMatchObject({
    status: "queued",
    workspaceSlotId: null,
  });
  expect(state.workspaceSlots.get(released.workspaceSlotId!)).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});
