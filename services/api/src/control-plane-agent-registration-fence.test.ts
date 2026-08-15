import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable host inventory registration fence", () => {
  it("rolls back when the inventory lease fence loses", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const calls: string[] = [];
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      listWorktreesByHost: async () => [],
      putHostInventoryFenced: async () => false,
      releaseHostConnection: async (_hostId: string, connectionId: string) => (
        calls.push(connectionId), true
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
    ).resolves.toEqual({ ok: false, error: "host connection changed while publishing inventory" });
    expect(calls).toEqual(["c"]);
  });

  it("rolls back when the authoritative inventory read fails", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => {
        throw new Error("read");
      },
      listWorktreesByHost: async () => [],
      releaseHostConnection: async () => true,
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).rejects.toThrow("read");
  });
});
