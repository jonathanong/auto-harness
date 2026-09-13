import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSessionWithConcurrency } from "./plane-storage-sessions-concurrency.ts";
import { sessionToItem, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const marker = [{ key: "repository:repo", now: "now" }];
const winner: SessionRecord = {
  id: "child-a",
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
  concurrencyId: "session-spawn:parent:key",
};
const candidate = { ...winner, id: "child-b", prompt: "redelivery" };
const admission = {
  drainCheck: null,
  activityPut: null,
  principalCheck: null,
  integrationCheck: undefined,
};

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

function indexOf(
  command: TransactWriteCommand,
  match: (item: NonNullable<TransactWriteCommand["input"]["TransactItems"]>[number]) => boolean,
): number {
  return (command.input.TransactItems ?? []).findIndex(match);
}

describe("parent fences vs marker lock winners", () => {
  it("rejects a failed separate parent fence before acknowledging a lock winner", async () => {
    await expect(
      createSessionWithConcurrency(
        ctx(async (command) => {
          if (command instanceof TransactWriteCommand) {
            const items = command.input.TransactItems ?? [];
            throw cancelled(
              [
                0,
                indexOf(command, (item) => item.ConditionCheck?.Key?.id === "parent"),
                indexOf(command, (item) => item.Put?.TableName === "Locks"),
              ],
              items.length,
            );
          }
          throw new Error("unexpected storage command");
        }),
        candidate,
        marker,
        {
          ...admission,
          parentFence: { id: "parent", rootSessionId: "root", sessionApiKeyHash: "hash" },
        },
      ),
    ).rejects.toMatchObject({ name: "ParentSessionAttemptEndedError" });
  });

  it("still acknowledges a lock winner when the separate parent fence holds", async () => {
    const result = await createSessionWithConcurrency(
      ctx(async (command) => {
        if (command instanceof TransactWriteCommand) {
          const items = command.input.TransactItems ?? [];
          throw cancelled(
            [0, indexOf(command, (item) => item.Put?.TableName === "Locks")],
            items.length,
          );
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
      {
        ...admission,
        parentFence: { id: "parent", rootSessionId: "root", sessionApiKeyHash: "hash" },
      },
    );
    expect(result).toEqual({ created: false, session: winner });
  });

  it("rejects a failed combined parent fence before acknowledging a lock winner", async () => {
    await expect(
      createSessionWithConcurrency(
        ctx(async (command) => {
          if (command instanceof TransactWriteCommand) {
            const items = command.input.TransactItems ?? [];
            throw cancelled(
              [
                0,
                indexOf(command, (item) => item.Put?.TableName === "Locks"),
                indexOf(command, (item) => item.Update?.Key?.id === "parent"),
              ],
              items.length,
            );
          }
          if (command instanceof GetCommand && command.input.TableName === "Sessions") {
            expect(command.input.Key).toEqual({ id: "parent" });
            return {
              Item: sessionToItem({
                ...winner,
                id: "parent",
                status: "completed",
                sessionApiKeyHash: "hash",
              }),
            };
          }
          throw new Error("unexpected storage command");
        }),
        candidate,
        marker,
        {
          ...admission,
          parentFence: { id: "parent", rootSessionId: "parent", sessionApiKeyHash: "hash" },
        },
      ),
    ).rejects.toMatchObject({ name: "ParentSessionAttemptEndedError" });
  });

  it("acknowledges a lock winner when a combined parent fence still holds", async () => {
    const result = await createSessionWithConcurrency(
      ctx(async (command) => {
        if (command instanceof TransactWriteCommand) {
          const items = command.input.TransactItems ?? [];
          throw cancelled(
            [
              0,
              indexOf(command, (item) => item.Put?.TableName === "Locks"),
              indexOf(command, (item) => item.Update?.Key?.id === "parent"),
            ],
            items.length,
          );
        }
        if (command instanceof GetCommand && command.input.TableName === "Locks") {
          return { Item: { sessionId: winner.id } };
        }
        if (command instanceof GetCommand && command.input.TableName === "Sessions") {
          const id = (command.input.Key as { id: string }).id;
          if (id === "parent") {
            return {
              Item: sessionToItem({
                ...winner,
                id: "parent",
                status: "running",
                sessionApiKeyHash: "hash",
              }),
            };
          }
          return { Item: sessionToItem(winner) };
        }
        throw new Error("unexpected storage command");
      }),
      candidate,
      marker,
      {
        ...admission,
        parentFence: { id: "parent", rootSessionId: "parent", sessionApiKeyHash: "hash" },
      },
    );
    expect(result).toEqual({ created: false, session: winner });
  });
});
