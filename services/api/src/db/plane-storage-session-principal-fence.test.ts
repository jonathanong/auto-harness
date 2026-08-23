import { describe, expect, it } from "vitest";

import { createSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("durable session principal fence", () => {
  it("requires the authenticated principal to exist in the admission transaction", async () => {
    let transaction: Record<string, unknown> | undefined;
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          transaction = command.input;
          return {};
        },
      },
      tables: {
        concurrencyLocks: "Locks",
        repositories: "Repositories",
        sessionDrains: "SessionDrains",
        sessions: "Sessions",
        users: "Users",
      },
    } as unknown as PlaneStorageCtx;

    await expect(
      createSession(ctx, {
        id: "session",
        repositoryId: "repository",
        principalId: "principal",
        prompt: "test",
        target: { commandId: "command" },
        fallbacks: [],
        targetLabels: ["command"],
        queueTtlSeconds: 60,
        queueExpiresAt: "2026-01-01T00:01:00.000Z",
        timeout: 30,
        priority: 0,
        requiredLabels: [],
        status: "queued",
        queueShard: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ created: true });

    expect(transaction?.TransactItems).toEqual(
      expect.arrayContaining([
        {
          ConditionCheck: {
            TableName: "Users",
            Key: { id: "principal" },
            ConditionExpression: "attribute_exists(id)",
          },
        },
      ]),
    );
  });
});
