/* eslint-disable max-lines -- pagination and conditional storage cases share one fixture. */
import { describe, expect, it, vi } from "vitest";

import {
  createWorkspacePool,
  deleteWorkspacePool,
  deleteWorkspaceSlot,
  deleteWorkspaceSlotIfIdle,
  deleteRetiredWorkspaceSlotIfIdle,
  getWorkspacePool,
  getWorkspacePoolSummary,
  getWorkspaceSlot,
  listWorkspacePools,
  listWorkspacePoolSummaries,
  listWorkspaceSlots,
  listWorkspaceSlotsByHost,
  listWorkspaceSlotsByPool,
  putWorkspacePool,
  putWorkspaceSlot,
  putWorkspaceSlotFenced,
  retireWorkspaceSlot,
  updateWorkspacePool,
  tryAssignWorkspaceSession,
} from "./plane-storage-workspaces.ts";
import type { PlaneStorageCtx, WorkspacePoolRecord } from "./plane-storage-types.ts";
import type { WorkspaceSlotRecord } from "./types.ts";

const pool: WorkspacePoolRecord = {
  id: "pool",
  name: "pool",
  setupProfiles: [],
  destroyWorkspaceAfter: false,
  createdAt: "now",
  updatedAt: "now",
};
const slot: WorkspaceSlotRecord = {
  id: "slot",
  workspacePoolId: "pool",
  hostId: "host",
  name: "slot",
  path: "/tmp/slot",
  status: "idle",
  online: true,
  currentSessionId: null,
  connectionId: "connection",
  updatedAt: "now",
};

function ctx(send: (command: { input: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send } as never,
    tables: {
      workspacePools: "WorkspacePools",
      workspaceSlots: "WorkspaceSlots",
      sessions: "Sessions",
      hostLocks: "HostLocks",
      providerAccounts: "ProviderAccounts",
      concurrencyLocks: "ConcurrencyLocks",
    } as never,
  } satisfies PlaneStorageCtx;
}

const conditional = () =>
  Object.assign(new Error("lost"), { name: "ConditionalCheckFailedException" });

function cancelled(length: number, failed: number, secondFailure?: number) {
  return {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length }, (_, index) => ({
      Code: index === failed || index === secondFailure ? "ConditionalCheckFailed" : "None",
    })),
  };
}

const assignment = {
  sessionId: "session",
  workspacePoolId: "pool",
  workspaceSlotId: "slot",
  hostId: "host",
  connectionId: "connection",
  now: "2026-01-01T00:00:00.000Z",
  attemptId: "attempt",
  resolvedArgv: ["echo"],
  resolvedRoute: {
    targetIndex: 0,
    commandId: "command",
    hostId: "host",
    worktreeId: null,
    workspacePoolId: "pool",
    workspaceSlotId: "slot",
    attemptId: "attempt",
  },
  queueShard: 0,
};

describe("workspace storage", () => {
  it("lists pool summaries without projecting trusted setup scripts", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          id: pool.id,
          name: pool.name,
          setupProfileSummaries: [{ id: "install", name: "Install" }],
          defaultSetupProfileId: "install",
          destroyWorkspaceAfter: false,
          createdAt: pool.createdAt,
          updatedAt: pool.updatedAt,
          // A fake client returning this proves the caller never consumes it.
          setupProfiles: [{ id: "install", name: "Install", script: "secret" }],
        },
      ],
    });
    const result = await listWorkspacePoolSummaries(ctx(send));
    expect(result).toEqual([
      {
        id: pool.id,
        name: pool.name,
        setupProfiles: [{ id: "install", name: "Install" }],
        defaultSetupProfileId: "install",
        destroyWorkspaceAfter: false,
        createdAt: pool.createdAt,
        updatedAt: pool.updatedAt,
      },
    ]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ProjectionExpression: expect.not.stringContaining("setupProfiles,"),
          ExpressionAttributeNames: { "#name": "name" },
          Limit: 100,
        }),
      }),
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("maps legacy pool summaries without profile projections or defaults", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ id: "legacy", name: "Legacy", destroyWorkspaceAfter: true }],
    });
    await expect(listWorkspacePoolSummaries(ctx(send))).resolves.toEqual([
      {
        id: "legacy",
        name: "Legacy",
        setupProfiles: [],
        destroyWorkspaceAfter: true,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ]);

    await expect(listWorkspacePoolSummaries(ctx(vi.fn().mockResolvedValue({})))).resolves.toEqual(
      [],
    );
  });

  it("point-reads public pool metadata without a script-bearing read or scan", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        id: pool.id,
        name: pool.name,
        setupProfileSummaries: [{ id: "install", name: "Install" }],
        defaultSetupProfileId: "install",
        destroyWorkspaceAfter: false,
        createdAt: pool.createdAt,
        updatedAt: pool.updatedAt,
        setupProfiles: [{ id: "install", name: "Install", script: "secret" }],
      },
    });

    await expect(getWorkspacePoolSummary(ctx(send), pool.id)).resolves.toEqual({
      id: pool.id,
      name: pool.name,
      setupProfiles: [{ id: "install", name: "Install" }],
      defaultSetupProfileId: "install",
      destroyWorkspaceAfter: false,
      createdAt: pool.createdAt,
      updatedAt: pool.updatedAt,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: { id: pool.id },
          ProjectionExpression: expect.not.stringContaining("setupProfiles,"),
        }),
      }),
    );
  });

  it("reads, writes, lists, queries, and deletes pool and slot rows", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: pool })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [pool] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: slot })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [slot] })
      .mockResolvedValueOnce({ Items: [slot] })
      .mockResolvedValueOnce({ Items: [slot] });
    const storage = ctx(send);

    await expect(putWorkspacePool(storage, pool)).resolves.toBeUndefined();
    await expect(createWorkspacePool(storage, pool)).resolves.toBe(true);
    await expect(getWorkspacePool(storage, pool.id)).resolves.toEqual(pool);
    await expect(getWorkspacePool(storage, "missing")).resolves.toBeNull();
    await expect(listWorkspacePools(storage)).resolves.toEqual([pool]);
    await expect(deleteWorkspacePool(storage, pool.id)).resolves.toBe(true);
    await expect(putWorkspaceSlot(storage, slot)).resolves.toBeUndefined();
    await expect(getWorkspaceSlot(storage, slot.id)).resolves.toEqual(slot);
    await expect(getWorkspaceSlot(storage, "missing")).resolves.toBeNull();
    await expect(listWorkspaceSlots(storage)).resolves.toEqual([slot]);
    await expect(listWorkspaceSlotsByPool(storage, pool.id)).resolves.toEqual([slot]);
    await expect(listWorkspaceSlotsByHost(storage, slot.hostId)).resolves.toEqual([slot]);
    await expect(deleteWorkspaceSlot(storage, slot.id)).resolves.toBeUndefined();

    expect(send.mock.calls.map(([command]) => command.input.TableName)).toEqual(
      expect.arrayContaining(["WorkspacePools", "WorkspaceSlots"]),
    );
    expect(send.mock.calls[10]?.[0].input).toMatchObject({
      IndexName: "workspacePoolId-id",
      ExpressionAttributeValues: { ":value": "pool" },
    });
  });

  it("paginates pool/slot scans and both slot queries", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      calls.push(command.input);
      const input = command.input;
      if (input.TableName === "WorkspacePools") {
        return calls.filter((call) => call.TableName === "WorkspacePools").length === 1
          ? { Items: [pool], LastEvaluatedKey: { id: "pool-next" } }
          : { Items: [{ ...pool, id: "pool-2" }] };
      }
      if (input.IndexName === "workspacePoolId-id") {
        return calls.filter((call) => call.IndexName === "workspacePoolId-id").length === 1
          ? { Items: [slot], LastEvaluatedKey: { workspacePoolId: "pool", id: "slot-next" } }
          : { Items: [{ ...slot, id: "slot-2" }] };
      }
      if (input.IndexName === "hostId-id") {
        return calls.filter((call) => call.IndexName === "hostId-id").length === 1
          ? { Items: [slot], LastEvaluatedKey: { hostId: "host", id: "slot-next" } }
          : { Items: [{ ...slot, id: "slot-3" }] };
      }
      return calls.filter((call) => call.TableName === "WorkspaceSlots").length === 1
        ? { Items: [slot], LastEvaluatedKey: { id: "slot-next" } }
        : { Items: [{ ...slot, id: "slot-4" }] };
    });
    const storage = ctx(send);
    await expect(listWorkspacePools(storage)).resolves.toHaveLength(2);
    await expect(listWorkspaceSlots(storage)).resolves.toHaveLength(2);
    await expect(listWorkspaceSlotsByPool(storage, pool.id)).resolves.toHaveLength(2);
    await expect(listWorkspaceSlotsByHost(storage, slot.hostId)).resolves.toHaveLength(2);
    expect(calls[1]).toMatchObject({ ExclusiveStartKey: { id: "pool-next" } });
    expect(calls[3]).toMatchObject({ ExclusiveStartKey: { id: "slot-next" } });
    expect(calls[5]).toMatchObject({
      ExclusiveStartKey: { workspacePoolId: "pool", id: "slot-next" },
    });
    expect(calls[7]).toMatchObject({ ExclusiveStartKey: { hostId: "host", id: "slot-next" } });
  });

  it("treats empty scan and query pages as empty workspace inventories", async () => {
    const storage = ctx(vi.fn().mockResolvedValue({}));
    await expect(listWorkspacePools(storage)).resolves.toEqual([]);
    await expect(listWorkspaceSlots(storage)).resolves.toEqual([]);
    await expect(listWorkspaceSlotsByPool(storage, "pool")).resolves.toEqual([]);
    await expect(listWorkspaceSlotsByHost(storage, "host")).resolves.toEqual([]);
  });

  it("conditionally updates existing pools and publishes idle slots for one connection", async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = ctx(send);
    await expect(updateWorkspacePool(storage, pool)).resolves.toBe(true);
    await expect(putWorkspaceSlotFenced(storage, slot, "connection", "connection")).resolves.toBe(
      true,
    );
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      ConditionExpression: "attribute_exists(id)",
    });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      ConditionExpression: expect.stringContaining("currentSessionId = :null"),
      ExpressionAttributeValues: expect.objectContaining({ ":expectedConnectionId": "connection" }),
    });
    const conditionalStorage = ctx(vi.fn().mockRejectedValue(conditional()));
    await expect(updateWorkspacePool(conditionalStorage, pool)).resolves.toBe(false);
    await expect(putWorkspaceSlotFenced(conditionalStorage, slot, "connection")).resolves.toBe(
      false,
    );
  });

  it("conditionally deletes only an unclaimed workspace slot", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(deleteWorkspaceSlotIfIdle(ctx(send), "slot")).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      ConditionExpression: expect.stringContaining("currentSessionId = :null"),
      ExpressionAttributeValues: { ":busy": "busy", ":null": null },
    });
    await expect(
      deleteWorkspaceSlotIfIdle(ctx(vi.fn().mockRejectedValue(conditional())), "slot"),
    ).resolves.toBe(false);
  });

  it("fences retirement to its owner and deletes the released tombstone", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(retireWorkspaceSlot(ctx(send), "slot", "session")).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      ConditionExpression: "currentSessionId = :sessionId",
      ExpressionAttributeValues: expect.objectContaining({ ":retired": true }),
    });
    await expect(deleteRetiredWorkspaceSlotIfIdle(ctx(send), "slot")).resolves.toBe(true);
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      ConditionExpression: expect.stringContaining("retired = :retired"),
      ExpressionAttributeValues: expect.objectContaining({ ":retired": true }),
    });
    await expect(
      retireWorkspaceSlot(ctx(vi.fn().mockRejectedValue(conditional())), "slot", "session"),
    ).resolves.toBe(false);
    await expect(
      deleteRetiredWorkspaceSlotIfIdle(ctx(vi.fn().mockRejectedValue(conditional())), "slot"),
    ).resolves.toBe(false);
  });

  it("propagates storage failures while fencing slot lifecycle changes", async () => {
    const unavailable = new Error("storage unavailable");
    const storage = ctx(vi.fn().mockRejectedValue(unavailable));

    await expect(retireWorkspaceSlot(storage, "slot", "session")).rejects.toThrow(
      "storage unavailable",
    );
    await expect(putWorkspaceSlotFenced(storage, slot, "connection")).rejects.toThrow(
      "storage unavailable",
    );
    await expect(deleteWorkspaceSlotIfIdle(storage, "slot")).rejects.toThrow("storage unavailable");
    await expect(deleteRetiredWorkspaceSlotIfIdle(storage, "slot")).rejects.toThrow(
      "storage unavailable",
    );
  });

  it("handles conditional catalog outcomes and owned deletion", async () => {
    await expect(
      createWorkspacePool(ctx(vi.fn().mockRejectedValue(conditional())), pool),
    ).resolves.toBe(false);
    await expect(
      deleteWorkspacePool(ctx(vi.fn().mockRejectedValue(conditional())), pool.id),
    ).resolves.toBe(false);
    const owned = vi.fn().mockResolvedValue({});
    await expect(
      deleteWorkspacePool(ctx(owned), pool.id, [
        { key: "workspace-pool:pool", owner: "owner", now: "now" },
      ]),
    ).resolves.toBe(true);
    expect(owned.mock.calls[0]?.[0].input.TransactItems).toHaveLength(2);

    const unavailable = new Error("unavailable");
    await expect(
      createWorkspacePool(ctx(vi.fn().mockRejectedValue(unavailable)), pool),
    ).rejects.toThrow("unavailable");
    await expect(
      updateWorkspacePool(ctx(vi.fn().mockRejectedValue(unavailable)), pool),
    ).rejects.toThrow("unavailable");
    await expect(
      deleteWorkspacePool(ctx(vi.fn().mockRejectedValue(unavailable)), pool.id),
    ).rejects.toThrow("unavailable");
  });

  it("atomically assigns a slot and distinguishes provider lease collisions", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(tryAssignWorkspaceSession(ctx(send), assignment)).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0].input.TransactItems).toHaveLength(4);
    expect(send.mock.calls[0]?.[0].input.TransactItems[2].Update).toMatchObject({
      Key: { id: "session" },
      ExpressionAttributeValues: expect.objectContaining({
        ":poolId": "pool",
        ":slotId": "slot",
        ":primaryCommandStartState": "pending",
      }),
    });

    const withLease = {
      ...assignment,
      providerId: "provider",
      providerAccountId: "account",
      providerAccountLease: {
        concurrencyId: "acct:account:0",
        providerAccountId: "account",
        slot: 0,
        attemptId: "attempt",
      },
      hostAssignmentLease: { hostId: "host" },
      hostAssignmentCap: 2,
      legacyAssignmentCount: 0,
    };
    await expect(tryAssignWorkspaceSession(ctx(send), withLease)).resolves.toBe(true);
    const items = send.mock.calls[1]?.[0].input.TransactItems;
    expect(items).toHaveLength(6);
    expect(items[5].Put.Item).toMatchObject({ providerAccountId: "account", slot: 0 });

    await expect(
      tryAssignWorkspaceSession(ctx(send), { ...assignment, providerAccountId: "account" }),
    ).resolves.toBe(true);
    expect(send.mock.calls[2]?.[0].input.TransactItems).toHaveLength(5);
    expect(
      send.mock.calls[2]?.[0].input.TransactItems[4].Update.ExpressionAttributeValues,
    ).not.toHaveProperty(":providerId");

    await expect(
      tryAssignWorkspaceSession(ctx(vi.fn().mockRejectedValue(conditional())), assignment),
    ).resolves.toBe(false);
    await expect(
      tryAssignWorkspaceSession(ctx(vi.fn().mockRejectedValue(cancelled(6, 5))), withLease),
    ).resolves.toBe("lease_collision");
    await expect(
      tryAssignWorkspaceSession(ctx(vi.fn().mockRejectedValue(cancelled(6, 5, 2))), withLease),
    ).resolves.toBe(false);
    await expect(
      tryAssignWorkspaceSession(
        ctx(vi.fn().mockRejectedValue(new Error("unavailable"))),
        assignment,
      ),
    ).rejects.toThrow("unavailable");
  });
});
