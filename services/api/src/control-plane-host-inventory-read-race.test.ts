import { describe, expect, it } from "vitest";

import { putHostInventoryDurable } from "./control-plane-agent-hosts.ts";
import { listHostInventoriesDurable } from "./control-plane-durable-read-catalog.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("durable host inventory reads", () => {
  it("retries a scan that overlaps a durable mutation", async () => {
    let releaseStaleScan!: (records: never[]) => void;
    const staleScan = new Promise<never[]>((resolve) => (releaseStaleScan = resolve));
    let listCalls = 0;
    let durableInventory:
      | { hostId: string; repositories: never[]; commandProfiles: Record<string, never> }
      | undefined;
    const state = createControlPlaneState({
      storage: {
        listHostInventories: async () => {
          listCalls += 1;
          if (listCalls === 1) return staleScan;
          return durableInventory ? [{ ...durableInventory }] : [];
        },
        listAllWorktrees: async () => [],
        putHostInventory: async (record: typeof durableInventory) => {
          durableInventory = record;
        },
      } as never,
    });

    const overlappingRead = listHostInventoriesDurable(state);
    await expect(
      putHostInventoryDurable(state, "new-host", { repositories: [], commandProfiles: {} }),
    ).resolves.toMatchObject({ ok: true });
    releaseStaleScan([]);

    await expect(overlappingRead).resolves.toMatchObject([{ hostId: "new-host" }]);
    expect(listCalls).toBe(3);
  });
});
