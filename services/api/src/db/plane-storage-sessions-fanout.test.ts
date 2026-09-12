import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession, isCreateSessionConflict } from "./plane-storage-sessions.ts";
import { MAX_SESSION_DESCENDANTS } from "./plane-storage-sessions-concurrency.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
const session = {
  id: "child",
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
  concurrencyId: "spawn-key",
};

function ctx(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: {
      sessions: "Sessions",
      concurrencyLocks: "Locks",
      repositories: "Repositories",
      sessionDrains: "SessionDrains",
    } as never,
  } as PlaneStorageCtx;
}

function cancelled(...failed: number[]) {
  return {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: 8 }, (_, index) => ({
      Code: failed.includes(index) ? "ConditionalCheckFailed" : "None",
    })),
  };
}

describe("durable session fan-out budget", () => {
  it("updates the lineage root atomically with the lock and child row", async () => {
    const commands: TransactWriteCommand[] = [];
    await expect(
      createSession(
        ctx(async (candidate) => {
          commands.push(candidate as TransactWriteCommand);
          return {};
        }),
        session,
        [],
        { id: "parent", rootSessionId: "parent" },
      ),
    ).resolves.toMatchObject({ created: true });

    const items = commands[0]?.input.TransactItems ?? [];
    expect(items.length).toBeLessThanOrEqual(100);
    expect(items).toContainEqual({
      Update: {
        TableName: "Sessions",
        Key: { id: "parent" },
        UpdateExpression: "SET descendantCount = if_not_exists(descendantCount, :zero) + :one",
        ConditionExpression:
          "attribute_exists(id) AND #status IN (:running, :completed, :failed, :cancelled, :timedOut) AND (attribute_not_exists(descendantCount) OR descendantCount < :max)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":max": MAX_SESSION_DESCENDANTS,
          ":running": "running",
          ":completed": "completed",
          ":failed": "failed",
          ":cancelled": "cancelled",
          ":timedOut": "timed_out",
        },
      },
    });

    await createSession(
      ctx(async (candidate) => {
        commands.push(candidate as TransactWriteCommand);
        return {};
      }),
      { ...session, id: "grandchild" },
      [],
      { id: "child", rootSessionId: "parent", sessionApiKeyHash: "attempt-hash" },
    );
    const grandchildItems = commands[1]?.input.TransactItems ?? [];
    expect(
      grandchildItems.find((item) => item.Update?.Key?.id === "parent")?.Update
        ?.ExpressionAttributeValues,
    ).toEqual({ ":zero": 0, ":one": 1, ":max": MAX_SESSION_DESCENDANTS });
    expect(
      grandchildItems.find((item) => item.ConditionCheck?.Key?.id === "child")?.ConditionCheck,
    ).toMatchObject({
      ExpressionAttributeValues: {
        ":running": "running",
        ":sessionApiKeyHash": "attempt-hash",
      },
    });
  });

  it("maps budget exhaustion to conflict and still returns an existing duplicate", async () => {
    let transaction = true;
    const result = await createSession(
      ctx(async (candidate) => {
        if (candidate instanceof TransactWriteCommand && transaction) {
          transaction = false;
          throw cancelled(4);
        }
        if (candidate instanceof GetCommand && candidate.input.TableName === "Locks") {
          return { Item: { sessionId: "existing" } };
        }
        if (candidate instanceof GetCommand && candidate.input.TableName === "Sessions") {
          return { Item: { ...session, id: "existing", status: "queued" } };
        }
        throw new Error("unexpected storage command");
      }),
      session,
      [],
      { id: "parent", rootSessionId: "root" },
    );
    expect(result).toMatchObject({ created: false, session: { id: "existing" } });
  });

  it("reports an exhausted root budget as a create conflict", async () => {
    let transaction = true;
    const error = await createSession(
      ctx(async (candidate) => {
        if (candidate instanceof TransactWriteCommand && transaction) {
          transaction = false;
          throw cancelled(4);
        }
        if (candidate instanceof GetCommand) return {};
        throw new Error("unexpected storage command");
      }),
      session,
      [],
      { id: "parent", rootSessionId: "root" },
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "SessionDescendantBudgetExceededError" });
    expect(isCreateSessionConflict(error)).toBe(true);
  });

  it("keeps parent attempt fencing ahead of a simultaneous budget failure", async () => {
    await expect(
      createSession(
        ctx(async (candidate) => {
          if (candidate instanceof TransactWriteCommand) throw cancelled(1, 3);
          if (candidate instanceof GetCommand) return { Item: { ...session, status: "queued" } };
          throw new Error("unexpected storage command");
        }),
        session,
        [],
        { id: "parent", rootSessionId: "parent" },
      ),
    ).rejects.toMatchObject({ name: "ParentSessionAttemptEndedError" });
  });

  it("rejects a child transaction that would exceed DynamoDB's action limit", async () => {
    let sent = false;
    const markers = Array.from({ length: 100 }, (_, index) => ({
      key: `marker-${index}`,
      now: "now",
    }));
    await expect(
      createSession(
        ctx(async () => {
          sent = true;
          return {};
        }),
        session,
        markers,
        { id: "parent", rootSessionId: "parent" },
      ),
    ).rejects.toThrow("100 transaction action limit");
    expect(sent).toBe(false);
  });
});
