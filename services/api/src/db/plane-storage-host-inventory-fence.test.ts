import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { putHostInventoryFenced } from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("fenced host inventory publication", () => {
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
    ).resolves.toBe(true);
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
    ).resolves.toBe(false);
  });
});
