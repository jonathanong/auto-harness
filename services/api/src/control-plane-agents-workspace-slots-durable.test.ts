/* eslint-disable max-lines */
import { expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";

function runningWorkspaceSession() {
  return {
    id: "workspace-session",
    repositoryId: "",
    workspacePoolId: "pool",
    workspaceSlotId: "slot",
    workspaceSlotLease: true,
    prompt: "p",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: [],
    queueTtlSeconds: 300,
    queueExpiresAt: "later",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    status: "running" as const,
    queueShard: 0,
    createdAt: "t",
    hostId: "h",
    worktreeId: null,
    attemptId: "attempt",
    ackReceivedAt: "t",
    reconnectDeadlineAt: "later",
    assignmentConnectionId: "old",
  };
}

function busyWorkspaceSlot(sessionId: string) {
  return {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "h",
    workspacePoolId: "pool",
    status: "busy" as const,
    online: false,
    currentSessionId: sessionId,
    connectionId: "old",
  };
}

it("rolls back durable registration when workspace-slot publication fails", async () => {
  const plane = new ControlPlane({ connectionIdFactory: () => "c" });
  const released: string[] = [];
  const slots = [
    {
      id: "busy-slot",
      hostId: "h",
      workspacePoolId: "pool",
      name: "busy",
      path: "/workspace/busy",
      status: "busy" as const,
      online: true,
      currentSessionId: "running",
      connectionId: "old",
    },
    {
      id: "slot-1",
      hostId: "h",
      workspacePoolId: "pool",
      name: "one",
      path: "/workspace/one",
      status: "idle" as const,
      online: false,
      currentSessionId: null,
    },
    {
      id: "slot-2",
      hostId: "h",
      workspacePoolId: "pool",
      name: "two",
      path: "/workspace/two",
      status: "idle" as const,
      online: false,
      currentSessionId: null,
    },
  ];
  plane.state.storage = {
    tryRegisterHost: async () => true,
    putHostInventoryFenced: async () => ({ ok: true }),
    getHostInventory: async () => null,
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => slots,
    putWorkspaceSlot: async (slot: (typeof slots)[number] & { connectionId?: string }) => {
      if (slot.id === "slot-2" && slot.online) throw new Error("slot write");
      const index = slots.findIndex((candidate) => candidate.id === slot.id);
      slots[index] = slot;
    },
    deleteWorkspaceSlot: async () => undefined,
    releaseHostConnection: async (_hostId: string, connectionId: string) => (
      released.push(connectionId),
      true
    ),
    getHostLock: async () => null,
  } as never;

  await expect(
    plane.registerHostDurable({
      hostId: "h",
      worktrees: [],
      commandProfiles: [],
      replaceExisting: true,
    }),
  ).rejects.toThrow("slot write");
  expect(released).toEqual(["c"]);
  expect(plane.state.hostConnection.has("h")).toBe(false);
  expect(plane.state.connections.has("c")).toBe(false);
  expect(slots.find((slot) => slot.id === "slot-1")).toMatchObject({
    online: false,
    connectionId: "c",
  });
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({ online: false });
});

it("fences a published slot during rollback after the inventory lease changes", async () => {
  const plane = new ControlPlane({ connectionIdFactory: () => "candidate" });
  const slots = [
    {
      id: "slot",
      hostId: "h",
      workspacePoolId: "pool",
      name: "slot",
      path: "/workspace",
      status: "idle" as const,
      online: false,
      currentSessionId: null,
      connectionId: "old",
    },
  ];
  const putWorkspaceSlotFenced = vi.fn(async (next: (typeof slots)[number]) => {
    slots[0] = next;
    return true;
  });
  plane.state.storage = {
    tryRegisterHost: async () => true,
    getHostInventory: async () => null,
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => slots,
    putWorkspaceSlot: async () => undefined,
    putWorkspaceSlotFenced,
    putHostInventoryFenced: async () => ({ ok: false, reason: "lease" as const }),
    releaseHostConnection: async () => true,
    getHostLock: async () => null,
  } as never;

  await expect(
    plane.registerHostDurable({
      hostId: "h",
      worktrees: [],
      workspacePools: [],
      commandProfiles: [],
      replaceExisting: true,
    }),
  ).resolves.toEqual({
    ok: false,
    error: "host connection changed while publishing inventory",
  });
  expect(putWorkspaceSlotFenced).toHaveBeenCalledTimes(2);
  expect(slots[0]).toMatchObject({ online: false });
});

it("accepts an exact durable workspace ownership claim before confirming its reconnect", async () => {
  const plane = new ControlPlane({ connectionIdFactory: () => "replacement" });
  const session = runningWorkspaceSession();
  const slot = busyWorkspaceSlot(session.id);
  const confirmWorkspaceReconnect = vi.fn(async () => true);
  plane.state.storage = {
    getSession: async () => session,
    getWorkspaceSlot: async () => slot,
    tryRegisterHost: async () => true,
    getHostInventory: async () => null,
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    putHostInventoryFenced: async () => ({ ok: true }),
    confirmWorkspaceReconnect,
    listActiveSessionsByHost: async () => [session],
  } as never;

  await expect(
    plane.registerHostDurable({
      hostId: "h",
      worktrees: [],
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "slot", name: "slot", path: "/workspace" }],
        },
      ],
      commandProfiles: [],
      runningSessions: [session.id],
      replaceExisting: true,
    }),
  ).resolves.toEqual({ ok: true, connectionId: "replacement" });

  expect(confirmWorkspaceReconnect).toHaveBeenCalledWith({
    sessionId: session.id,
    hostId: "h",
    workspaceSlotId: slot.id,
    deadlineAt: session.reconnectDeadlineAt,
    connectionId: "replacement",
  });
  expect(plane.state.sessions.get(session.id)).not.toHaveProperty("reconnectDeadlineAt");
  expect(plane.state.workspaceSlots.get(slot.id)).toMatchObject({
    currentSessionId: session.id,
    online: true,
    connectionId: "replacement",
  });
});

it("returns a fenced workspace publication conflict and releases only the candidate lease", async () => {
  const plane = new ControlPlane({ connectionIdFactory: () => "candidate" });
  const slot = {
    id: "slot",
    name: "slot",
    path: "/workspace",
    hostId: "h",
    workspacePoolId: "pool",
    status: "idle" as const,
    online: false,
    currentSessionId: null,
    connectionId: "old",
  };
  const release = vi.fn(async () => true);
  plane.state.storage = {
    tryRegisterHost: async () => true,
    getHostInventory: async () => null,
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => [slot],
    putHostInventoryFenced: async () => ({ ok: true }),
    putWorkspaceSlot: vi.fn(async () => undefined),
    putWorkspaceSlotFenced: vi.fn(async () => false),
    setWorktreeOnlineFenced: vi.fn(async () => true),
    releaseHostConnection: release,
    getHostLock: async () => null,
  } as never;

  await expect(
    plane.registerHostDurable({
      hostId: "h",
      worktrees: [],
      workspacePools: [],
      commandProfiles: [],
      replaceExisting: true,
    }),
  ).resolves.toEqual({
    ok: false,
    error: "host connection changed while publishing workspace slots",
  });
  expect(release).toHaveBeenCalledWith("h", "candidate");
  expect(plane.state.hostConnection.has("h")).toBe(false);
});

it("rejects every durable workspace ownership mismatch", async () => {
  const validSession = runningWorkspaceSession();
  const cases = [
    [{ ...validSession, status: "queued" }, busyWorkspaceSlot(validSession.id)],
    [{ ...validSession, ackReceivedAt: undefined }, busyWorkspaceSlot(validSession.id)],
    [{ ...validSession, hostId: "other" }, busyWorkspaceSlot(validSession.id)],
    [{ ...validSession, workspaceSlotLease: false }, busyWorkspaceSlot(validSession.id)],
    [validSession, null],
    [validSession, { ...busyWorkspaceSlot(validSession.id), hostId: "other" }],
    [validSession, busyWorkspaceSlot("other")],
  ] as const;
  for (const [session, slot] of cases) {
    const plane = new ControlPlane();
    plane.state.storage = {
      getSession: async () => session,
      getWorkspaceSlot: async () => slot,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        workspacePools: [],
        commandProfiles: [],
        runningSessions: [session.id],
      }),
    ).resolves.toEqual({
      ok: false,
      error: `running session ${session.id} is not owned by host h`,
    });
  }
});
