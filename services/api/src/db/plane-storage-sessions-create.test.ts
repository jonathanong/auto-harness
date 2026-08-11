import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("marker-guarded session creation", () => {
  it("keeps a session-id collision distinct from a catalog deletion conflict", async () => {
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
          };
        },
      } as never,
      tables: { sessions: "Sessions", concurrencyLocks: "Locks" } as never,
    };
    await expect(
      createSession(
        ctx,
        {
          id: "session",
          repositoryId: "repo",
          prompt: "run",
          target: { commandId: "command" },
          fallbacks: [],
          targetLabels: [],
          queueTtlSeconds: 1,
          queueExpiresAt: "2026-01-01T00:00:01.000Z",
          timeout: 1,
          priority: 0,
          requiredLabels: [],
          status: "queued",
          queueShard: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        [{ key: "command:command", now: "now" }],
      ),
    ).rejects.toMatchObject({ name: "SessionIdCollisionError" });
  });
});
