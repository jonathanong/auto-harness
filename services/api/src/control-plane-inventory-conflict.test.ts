import { describe, expect, it } from "vitest";

import { putHostInventoryDurable } from "./control-plane-agent-hosts.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { HostInventoryRecord } from "./db/plane-storage.ts";

/**
 * PUT replaces the whole inventory document and every UI mutation is a client-side
 * read-modify-write, so two editors working from their own reads used to silently discard
 * one another's changes — and worktree projection then deleted the rows belonging to the
 * lost edit. The write is conditional on the version the caller read.
 */
function planeWithStorage() {
  let durable: HostInventoryRecord | undefined;
  const state = createControlPlaneState({
    storage: {
      listHostInventories: async () => (durable ? [{ ...durable }] : []),
      listAllWorktrees: async () => [],
      putWorktree: async () => undefined,
      deleteWorktree: async () => undefined,
      putHostInventory: async (
        record: HostInventoryRecord,
        _markers?: unknown,
        expectedVersion?: number,
      ) => {
        if (expectedVersion !== undefined && (durable?.version ?? 0) !== expectedVersion) {
          return false;
        }
        durable = record;
        return true;
      },
    } as never,
  });
  return { state, stored: () => durable };
}

const body = (version?: number) => ({
  repositories: [],
  commandProfiles: {},
  ...(version === undefined ? {} : { version }),
});

describe("host inventory optimistic concurrency", () => {
  it("advances the version on each accepted write", async () => {
    const { state, stored } = planeWithStorage();

    await putHostInventoryDurable(state, "host-a", body());
    expect(stored()?.version).toBe(1);
    await putHostInventoryDurable(state, "host-a", body(1));

    expect(stored()?.version).toBe(2);
  });

  it("refuses a write built from a stale read", async () => {
    const { state, stored } = planeWithStorage();
    await putHostInventoryDurable(state, "host-a", body());
    // Two editors both read version 1; the first one to write wins.
    await putHostInventoryDurable(state, "host-a", body(1));

    const loser = await putHostInventoryDurable(state, "host-a", body(1));

    expect(loser).toMatchObject({ ok: false, conflict: true });
    // The winner's write is intact rather than overwritten.
    expect(stored()?.version).toBe(2);
  });

  it("accepts a version-less body so pre-versioning callers keep working", async () => {
    const { state } = planeWithStorage();
    await putHostInventoryDurable(state, "host-a", body());

    await expect(putHostInventoryDurable(state, "host-a", body())).resolves.toMatchObject({
      ok: true,
    });
  });

  it("treats version 0 as 'no version seen yet'", async () => {
    const { state, stored } = planeWithStorage();

    await expect(putHostInventoryDurable(state, "host-a", body(0))).resolves.toMatchObject({
      ok: true,
    });

    expect(stored()?.version).toBe(1);
  });
});
