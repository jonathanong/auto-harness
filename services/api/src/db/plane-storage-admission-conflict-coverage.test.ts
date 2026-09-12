import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function cancelled(failedIndex: number) {
  return {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: 8 }, (_, index) => ({
      Code: index === failedIndex ? "ConditionalCheckFailed" : "None",
    })),
  };
}

const session = {
  id: "session",
  repositoryId: "repo",
  prompt: "prompt",
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "later",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  status: "queued" as const,
  queueShard: 0,
  createdAt: "now",
  concurrencyId: "key",
  principalId: "user:alice",
};

function ctx(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: {
      sessions: "Sessions",
      concurrencyLocks: "Locks",
      repositories: "Repositories",
      users: "Users",
      sessionDrains: "SessionDrains",
    } as never,
  } as PlaneStorageCtx;
}

describe("concurrent session admission conflicts", () => {
  it("maps principal, repository, and drain condition losses", async () => {
    await expect(
      createSession(
        ctx(async (command) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw cancelled(0);
        }),
        session,
      ),
    ).rejects.toMatchObject({ name: "CatalogDeletionInProgressError" });

    await expect(
      createSession(
        ctx(async (command) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw cancelled(1);
        }),
        session,
      ),
    ).rejects.toMatchObject({ name: "RepositoryAdmissionClosedError" });

    await expect(
      createSession(
        ctx(async (command) => {
          if (command instanceof TransactWriteCommand) throw cancelled(2);
          return { Item: { operationId: "drain-op" } };
        }),
        session,
      ),
    ).rejects.toMatchObject({
      name: "SessionDrainActiveError",
      operationId: "drain-op",
    });
  });
});
