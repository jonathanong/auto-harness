import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { deleteProvider } from "./plane-storage-catalog-providers.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("provider catalog deletion storage", () => {
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
