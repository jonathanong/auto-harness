import { describe, expect, it } from "vitest";

import {
  deleteHostInventoryDurable,
  putHostInventoryDurable,
} from "./control-plane-agent-hosts.ts";
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
      getHostInventory: async () => (durable ? { ...durable } : null),
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
      deleteHostInventory: async (_hostId: string, expectedVersion?: number) => {
        if ((durable?.version ?? 0) !== expectedVersion) return false;
        durable = undefined;
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
  it("waits for and retries the durable worktree projection before acknowledging", async () => {
    let durable: HostInventoryRecord | undefined;
    let projectionAttempts = 0;
    const worktrees = new Map<string, unknown>();
    const state = createControlPlaneState({
      storage: {
        listHostInventories: async () => (durable ? [{ ...durable }] : []),
        listAllWorktrees: async () => [],
        putHostInventory: async (record: HostInventoryRecord) => {
          durable = record;
          return true;
        },
        putWorktree: async (record: unknown) => {
          projectionAttempts += 1;
          if (projectionAttempts === 1) throw new Error("projection temporarily unavailable");
          worktrees.set((record as { id: string }).id, record);
        },
        deleteWorktree: async () => undefined,
      } as never,
    });
    const result = await putHostInventoryDurable(state, "host-a", {
      repositories: [
        {
          id: "repo-a",
          path: "/repo-a",
          defaultBranch: "main",
          worktrees: [{ id: "wt-a", name: "wt-a", path: "/repo-a/wt-a", labels: [] }],
        },
      ],
      commandProfiles: {},
    });

    expect(result).toMatchObject({ ok: true });
    expect(projectionAttempts).toBe(2);
    expect(worktrees.has("wt-a")).toBe(true);
  });

  it("does not report success when the committed projection cannot be repaired", async () => {
    const { state, stored } = planeWithStorage();
    state.storage!.putWorktree = async () => {
      throw new Error("projection unavailable");
    };

    const result = await putHostInventoryDurable(state, "host-a", {
      repositories: [
        {
          id: "repo-a",
          path: "/repo-a",
          defaultBranch: "main",
          worktrees: [{ id: "wt-a", name: "wt-a", path: "/repo-a/wt-a", labels: [] }],
        },
      ],
      commandProfiles: {},
    });

    expect(result).toMatchObject({ ok: false, committed: true });
    expect(stored()?.hostId).toBe("host-a");

    const stringFailure = planeWithStorage();
    stringFailure.state.storage!.putWorktree = async () => {
      throw "projection unavailable";
    };
    await expect(
      putHostInventoryDurable(stringFailure.state, "host-a", {
        repositories: [
          {
            id: "repo-a",
            path: "/repo-a",
            defaultBranch: "main",
            worktrees: [{ id: "wt-a", name: "wt-a", path: "/repo-a/wt-a", labels: [] }],
          },
        ],
        commandProfiles: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      error: "host inventory committed but worktree projection failed: projection unavailable",
    });
  });

  it("rejects inventories whose deletion catalog would exceed its reference cap", async () => {
    const { state, stored } = planeWithStorage();
    const repositories = Array.from({ length: 100 }, (_, index) => ({
      id: `repo-${index}`,
      path: `/repo-${index}`,
      defaultBranch: "main",
      worktrees: [],
    }));
    await expect(
      putHostInventoryDurable(state, "host-a", { repositories, commandProfiles: {} }),
    ).resolves.toEqual({ ok: false, error: "host inventory has too many catalog references" });
    expect(stored()).toBeUndefined();
  });

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

  it("refuses a delete whose capability check read an older version", async () => {
    const { state, stored } = planeWithStorage();
    await putHostInventoryDurable(state, "host-a", body());

    await expect(deleteHostInventoryDurable(state, "host-a", 0)).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(stored()?.version).toBe(1);
  });
});
