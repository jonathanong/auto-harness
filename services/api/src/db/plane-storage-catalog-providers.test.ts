import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { deleteProvider, putProvider } from "./plane-storage-catalog-providers.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("provider catalog deletion storage", () => {
  it("stores configured usage rates and removes them when omitted", async () => {
    const commands: UpdateCommand[] = [];
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(UpdateCommand);
          commands.push(command as UpdateCommand);
          return {};
        },
      } as never,
      tables: { providers: "Providers" } as never,
    };

    await putProvider(ctx, {
      id: "provider",
      name: "Provider",
      usageRates: { inputUsdPerMillion: "1.25" },
    });
    await putProvider(ctx, { id: "provider", name: "Provider" });

    expect(commands[0]?.input).toMatchObject({
      UpdateExpression: expect.stringContaining("usageRates = :usageRates"),
      ExpressionAttributeValues: {
        ":usageRates": { inputUsdPerMillion: "1.25" },
      },
    });
    expect(commands[1]?.input.UpdateExpression).toContain("REMOVE usageRates");
  });

  it("turns a stale owned-deletion transaction into a retryable false result", async () => {
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof GetCommand) return { Item: { id: "provider", accountCount: 0 } };
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
          };
        },
      } as never,
      tables: { providers: "Providers", concurrencyLocks: "Locks" } as never,
    };
    await expect(
      deleteProvider(ctx, "provider", [{ key: "provider:provider", owner: "old", now: "now" }]),
    ).resolves.toBe(false);
  });
});
