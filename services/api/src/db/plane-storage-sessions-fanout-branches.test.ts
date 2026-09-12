import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession } from "./plane-storage-sessions.ts";
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

function context(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
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

function cancelled(index: number) {
  return {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: 6 }, (_, candidate) => ({
      Code: candidate === index ? "ConditionalCheckFailed" : "None",
    })),
  };
}

describe("durable child admission branches", () => {
  it("combines a direct parent's attempt credential with its root budget fence", async () => {
    let transaction: TransactWriteCommand | undefined;
    await createSession(
      context(async (command) => {
        transaction = command as TransactWriteCommand;
        return {};
      }),
      session,
      [],
      { id: "parent", rootSessionId: "parent", sessionApiKeyHash: "hash" },
    );

    expect(
      transaction?.input.TransactItems?.find((item) => item.Update?.Key?.id === "parent")?.Update,
    ).toMatchObject({
      ConditionExpression: expect.stringContaining("sessionApiKeyHash = :sessionApiKeyHash"),
      ExpressionAttributeValues: expect.objectContaining({
        ":running": "running",
        ":sessionApiKeyHash": "hash",
      }),
    });
  });

  it("reports a failed separate parent attempt fence before the root budget", async () => {
    await expect(
      createSession(
        context(async (command) => {
          if (command instanceof TransactWriteCommand) throw cancelled(1);
          throw new Error("unexpected read");
        }),
        session,
        [],
        { id: "parent", rootSessionId: "root", sessionApiKeyHash: "hash" },
      ),
    ).rejects.toMatchObject({ name: "ParentSessionAttemptEndedError" });
  });

  it.each([
    [undefined, "ParentSessionAttemptEndedError"],
    [
      { ...session, id: "parent", status: "running", sessionApiKeyHash: "wrong" },
      "ParentSessionAttemptEndedError",
    ],
    [
      { ...session, id: "parent", status: "running", sessionApiKeyHash: "hash" },
      "SessionDescendantBudgetExceededError",
    ],
  ] as const)(
    "revalidates a direct parent after root budget cancellation",
    async (parent, name) => {
      await expect(
        createSession(
          context(async (command) => {
            if (command instanceof TransactWriteCommand) throw cancelled(3);
            if (command instanceof GetCommand && command.input.TableName === "Sessions") {
              return parent ? { Item: parent } : {};
            }
            if (command instanceof GetCommand && command.input.TableName === "Locks") return {};
            throw new Error("unexpected command");
          }),
          session,
          [],
          { id: "parent", rootSessionId: "parent", sessionApiKeyHash: "hash" },
        ),
      ).rejects.toMatchObject({ name });
    },
  );
});
