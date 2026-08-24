import { DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { deleteHostInventory, putHostInventoryFenced } from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("fenced host inventory publication", () => {
  it("conditions deletion on the inspected inventory version", async () => {
    const commands: DeleteCommand[] = [];
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(DeleteCommand);
          commands.push(command as DeleteCommand);
          if (commands.length === 2) throw { name: "ConditionalCheckFailedException" };
          return {};
        },
      } as never,
      tables: { hostInventories: "HostInventories" } as never,
    };

    await expect(deleteHostInventory(ctx, "host-1", 2)).resolves.toBe(true);
    expect(commands[0]?.input).toMatchObject({
      TableName: "HostInventories",
      Key: { hostId: "host-1" },
      ConditionExpression: "version = :expected",
      ExpressionAttributeValues: { ":expected": 2 },
    });
    await expect(deleteHostInventory(ctx, "host-1", 2)).resolves.toBe(false);
  });

  it("requires the exact connection lease", async () => {
    const commands: TransactWriteCommand[] = [];
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          commands.push(command as TransactWriteCommand);
          if (commands.length === 2) {
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
            };
          }
          return {};
        },
      } as never,
      tables: { hostInventories: "HostInventories", hostLocks: "HostLocks" } as never,
    };
    const inventory = {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: "2026-08-15T00:00:00.000Z",
    };

    await expect(
      putHostInventoryFenced(ctx, inventory, {
        hostId: "host-1",
        connectionId: "connection-1",
      }),
    ).resolves.toEqual({ ok: true });
    expect(commands[0]?.input).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: "HostLocks",
            Key: { hostId: "host-1" },
            ExpressionAttributeValues: { ":connectionId": "connection-1" },
          },
        },
        { Put: { TableName: "HostInventories", Item: inventory } },
      ],
    });
    await expect(
      putHostInventoryFenced(ctx, inventory, {
        hostId: "host-1",
        connectionId: "stale-connection",
      }),
    ).resolves.toEqual({ ok: false, reason: "lease" });
  });

  it("distinguishes a version conflict from a lease conflict", async () => {
    // Index 0 is the lease ConditionCheck, index 1 is the inventory Put — a caller
    // (registerHostDurable) needs to know which failed: a lease conflict means a
    // different connection won registration and is not retryable, while a version
    // conflict means a concurrent UI edit landed and is retryable by re-reading.
    const commands: TransactWriteCommand[] = [];
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command as TransactWriteCommand);
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
          };
        },
      } as never,
      tables: { hostInventories: "HostInventories", hostLocks: "HostLocks" } as never,
    };
    const inventory = {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: "2026-08-15T00:00:00.000Z",
      version: 3,
    };

    await expect(
      putHostInventoryFenced(ctx, inventory, { hostId: "host-1", connectionId: "connection-1" }, 2),
    ).resolves.toEqual({ ok: false, reason: "version" });
    expect(commands[0]?.input).toMatchObject({
      TransactItems: [
        {},
        {
          Put: {
            TableName: "HostInventories",
            ConditionExpression: "version = :expected",
            ExpressionAttributeValues: { ":expected": 2 },
          },
        },
      ],
    });
  });

  it("rethrows an error that is not a recognized conditional failure", async () => {
    const ctx: PlaneStorageCtx = {
      doc: { send: async () => Promise.reject(new Error("network down")) } as never,
      tables: { hostInventories: "HostInventories", hostLocks: "HostLocks" } as never,
    };
    const inventory = {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: "2026-08-15T00:00:00.000Z",
    };

    await expect(
      putHostInventoryFenced(ctx, inventory, { hostId: "host-1", connectionId: "connection-1" }),
    ).rejects.toThrow("network down");
  });
});
