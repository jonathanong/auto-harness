import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const session = {
  id: "s",
  repositoryId: "r",
  prompt: "p",
  target: { commandId: "c" },
  fallbacks: [],
  targetLabels: [],
  queueTtlSeconds: 1,
  queueExpiresAt: "later",
  timeout: 1,
  priority: 0,
  requiredLabels: [],
  status: "queued" as const,
  queueShard: 0,
  createdAt: "now",
  concurrencyId: "key",
};

describe("Dynamo session cancellation outcomes", () => {
  it("throws a collision when a vanished lock also loses the session-id condition", async () => {
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [
                { Code: "ConditionalCheckFailed" },
                { Code: "ConditionalCheckFailed" },
              ],
            };
          }
          expect(command).toBeInstanceOf(GetCommand);
          return {};
        },
      },
      tables: { sessions: "sessions", concurrencyLocks: "locks" },
    } as unknown as PlaneStorageCtx;

    await expect(createSession(ctx, session)).rejects.toThrow("session id collision: s");
  });

  it("returns the active owner when the cancelled transaction still finds its lock", async () => {
    let reads = 0;
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
            };
          }
          expect(command).toBeInstanceOf(GetCommand);
          reads += 1;
          return reads === 1
            ? { Item: { sessionId: "owner" } }
            : { Item: { id: "owner", status: "queued" } };
        },
      },
      tables: { sessions: "sessions", concurrencyLocks: "locks" },
    } as unknown as PlaneStorageCtx;

    await expect(createSession(ctx, session)).resolves.toMatchObject({
      created: false,
      session: { id: "owner" },
    });
  });
});
