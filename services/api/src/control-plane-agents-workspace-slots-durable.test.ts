import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

it("rolls back durable registration when workspace-slot publication fails", async () => {
  const plane = new ControlPlane({ connectionIdFactory: () => "c" });
  const released: string[] = [];
  const slots = [
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
    getHostInventory: async () => null,
    listWorktreesByHost: async () => [],
    listWorkspaceSlotsByHost: async () => slots,
    putWorkspaceSlot: async (slot: (typeof slots)[number] & { connectionId?: string }) => {
      if (slot.id === "slot-2" && slot.online) throw new Error("slot write");
      const index = slots.findIndex((candidate) => candidate.id === slot.id);
      slots[index] = slot;
    },
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
  expect(slots[0]).toMatchObject({ online: false, connectionId: "c" });
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({ online: false });
});
