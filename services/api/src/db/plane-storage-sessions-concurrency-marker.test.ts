import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession } from "./plane-storage-sessions.ts";
import { createSessionWithConcurrency } from "./plane-storage-sessions-concurrency.ts";
import { sessionToItem, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const marker = [{ key: "repository:repo", now: "now" }];
const winner: SessionRecord = {
  id: "delivery-a",
  repositoryId: "repo",
  prompt: "already admitted",
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "later",
  timeout: 30,
  priority: 0,
  requiredLabels: [],
  status: "queued",
  queueShard: 0,
  createdAt: "now",
  concurrencyId: "github-comment:issue_comment:42:9",
};
const candidate = { ...winner, id: "delivery-b", prompt: "redelivery" };

function cancelled(failed: number[], count: number) {
  return {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: count }, (_, index) => ({
      Code: failed.includes(index) ? "ConditionalCheckFailed" : "None",
    })),
  };
}

function ctx(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: {
      sessions: "Sessions",
      repositories: "Repositories",
      concurrencyLocks: "Locks",
      sessionDrains: "SessionDrains",
    } as never,
  } as PlaneStorageCtx;
}

function lockPutIndex(command: TransactWriteCommand, tableName: string): number {
  const items = command.input.TransactItems ?? [];
  return items.findIndex((item) => item.Put?.TableName === tableName);
}

describe("ingress lock winners vs catalog deletion markers", () => {
  it("acknowledges an active lock winner when a marker and lock fail together", async () => {
    const result = await createSession(
      ctx(async (command) => {
        if (command instanceof TransactWriteCommand) {
          const items = command.input.TransactItems ?? [];
          throw cancelled([0, lockPutIndex(command, "Locks")], items.length);
        }
        if (command instanceof GetCommand && command.input.TableName === "Locks") {
          return { Item: { sessionId: winner.id } };
        }
        if (command instanceof GetCommand && command.input.TableName === "Sessions") {
          return { Item: sessionToItem(winner) };
        }
        throw new Error("unexpected storage command");
      }),
      candidate,
      marker,
    );
    expect(result).toEqual({ created: false, session: winner });
  });

  it("fails closed when only the catalog marker condition loses", async () => {
    await expect(
      createSession(
        ctx(async (command) => {
          if (command instanceof TransactWriteCommand) {
            const items = command.input.TransactItems ?? [];
            throw cancelled([0], items.length);
          }
          throw new Error("unexpected storage command");
        }),
        candidate,
        marker,
      ),
    ).rejects.toMatchObject({ name: "CatalogDeletionInProgressError" });
  });

  it("fails closed when a marker and lock fail without an active winner", async () => {
    await expect(
      createSessionWithConcurrency(
        ctx(async (command) => {
          if (command instanceof TransactWriteCommand) {
            const items = command.input.TransactItems ?? [];
            throw cancelled([0, lockPutIndex(command, "Locks")], items.length);
          }
          if (command instanceof GetCommand) return {};
          throw new Error("unexpected storage command");
        }),
        candidate,
        marker,
        {
          drainCheck: null,
          activityPut: null,
          principalCheck: null,
          integrationCheck: undefined,
        },
      ),
    ).rejects.toMatchObject({ name: "CatalogDeletionInProgressError" });
  });
});
