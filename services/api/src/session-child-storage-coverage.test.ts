import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession } from "./db/plane-storage-sessions-create.ts";
import { createSessionWithConcurrency } from "./db/plane-storage-sessions-concurrency.ts";
import { listSessionChildren } from "./db/plane-storage-sessions-query.ts";
import { sessionToItem, type PlaneStorageCtx } from "./db/plane-storage-types.ts";
import { tableNames } from "./db/dynamo.ts";
import type { SessionRecord } from "./db/types.ts";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "child",
    repositoryId: "repository",
    prompt: "child prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 300,
    queueExpiresAt: "2026-01-01T00:05:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    concurrencyId: "repository:child",
    ...overrides,
  };
}

function fakeContext(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: tableNames("test"),
  };
}

function parentCondition(command: TransactWriteCommand, parentId: string) {
  const parent = command.input.TransactItems?.find(
    (item) => item.ConditionCheck?.Key?.id === parentId,
  )?.ConditionCheck;
  expect(parent).toBeDefined();
  return parent!;
}

describe("child session storage coverage", () => {
  it("maps child query pages and sends a cursor only when supplied", async () => {
    const commands: unknown[] = [];
    const responses = [
      {
        Items: [sessionToItem(session({ parentSessionId: "parent", id: "newest-child" }))],
        LastEvaluatedKey: { id: "newest-child", createdOrder: "order" },
      },
      {},
    ];
    const ctx = fakeContext(async (command) => {
      commands.push(command);
      return responses.shift();
    });

    await expect(
      listSessionChildren(ctx, "parent", 1, { id: "older-child", createdOrder: "older" }),
    ).resolves.toEqual({
      items: [session({ parentSessionId: "parent", id: "newest-child" })],
      nextKey: { id: "newest-child", createdOrder: "order" },
    });
    await expect(listSessionChildren(ctx, "parent", 1)).resolves.toEqual({ items: [] });

    expect((commands[0] as QueryCommand).input).toMatchObject({
      ExclusiveStartKey: { id: "older-child", createdOrder: "older" },
      IndexName: "parentSessionId-createdOrder",
    });
    expect((commands[1] as QueryCommand).input).not.toHaveProperty("ExclusiveStartKey");
  });

  it("fences parent creation with and without a session credential hash", async () => {
    const commands: TransactWriteCommand[] = [];
    const ctx = fakeContext(async (command) => {
      expect(command).toBeInstanceOf(TransactWriteCommand);
      commands.push(command as TransactWriteCommand);
      return {};
    });

    await expect(
      createSessionWithConcurrency(ctx, session(), [], {
        drainCheck: undefined,
        activityPut: undefined,
        principalCheck: undefined,
        parentFence: { id: "parent", sessionApiKeyHash: "credential-hash" },
      }),
    ).resolves.toMatchObject({ created: true, session: { id: "child" } });
    await expect(
      createSessionWithConcurrency(ctx, session({ id: "legacy-child" }), [], {
        drainCheck: undefined,
        activityPut: undefined,
        principalCheck: undefined,
        parentFence: { id: "legacy-parent" },
      }),
    ).resolves.toMatchObject({ created: true, session: { id: "legacy-child" } });

    expect(parentCondition(commands[0]!, "parent")).toMatchObject({
      ConditionExpression: "#status = :running AND sessionApiKeyHash = :sessionApiKeyHash",
      ExpressionAttributeValues: { ":running": "running", ":sessionApiKeyHash": "credential-hash" },
    });
    expect(parentCondition(commands[1]!, "legacy-parent")).toMatchObject({
      ConditionExpression: "#status IN (:running, :completed, :failed, :cancelled, :timedOut)",
      ExpressionAttributeValues: {
        ":running": "running",
        ":completed": "completed",
        ":failed": "failed",
        ":cancelled": "cancelled",
        ":timedOut": "timed_out",
      },
    });
  });

  it("forwards a parent fence through createSession's concurrency path", async () => {
    const commands: TransactWriteCommand[] = [];
    const ctx = fakeContext(async (command) => {
      expect(command).toBeInstanceOf(TransactWriteCommand);
      commands.push(command as TransactWriteCommand);
      return {};
    });

    await expect(
      createSession(ctx, session({ id: "forwarded-child" }), [], {
        id: "forwarded-parent",
        sessionApiKeyHash: "forwarded-hash",
      }),
    ).resolves.toMatchObject({ created: true, session: { id: "forwarded-child" } });

    expect(parentCondition(commands[0]!, "forwarded-parent")).toMatchObject({
      ExpressionAttributeValues: { ":sessionApiKeyHash": "forwarded-hash" },
    });
  });
});
