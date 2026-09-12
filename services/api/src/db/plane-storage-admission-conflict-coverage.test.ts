/* eslint-disable max-lines -- admission conflict matrix shares one transaction fixture. */
import { DeleteCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
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
      integrations: "Integrations",
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

  it("includes legacy and generation integration fences in the transaction", async () => {
    for (const generation of [undefined, "generation"]) {
      const send = async (command: unknown) => {
        expect(command).toBeInstanceOf(TransactWriteCommand);
        const items = (command as TransactWriteCommand).input.TransactItems ?? [];
        const integration = items.find(
          (item) => "ConditionCheck" in item && item.ConditionCheck?.TableName === "Integrations",
        );
        expect(integration).toMatchObject({
          ConditionCheck: {
            Key: { id: "custom-webhook:deploy" },
            ExpressionAttributeValues: {
              ":type": "custom-webhook",
              ":version": 2,
              ":enabled": true,
            },
          },
        });
        if (generation === undefined) {
          expect(integration?.ConditionCheck?.ExpressionAttributeValues).not.toHaveProperty(
            ":generation",
          );
        } else {
          expect(integration).toMatchObject({
            ConditionCheck: { ExpressionAttributeValues: { ":generation": generation } },
          });
        }
        return {};
      };
      await expect(
        createSession(ctx(send), { ...session, concurrencyId: undefined }, [], {
          id: "deploy",
          type: "custom-webhook",
          storageId: "custom-webhook:deploy",
          ...(generation === undefined ? {} : { generation }),
          version: 2,
          enabled: true,
        }),
      ).resolves.toMatchObject({ created: true });
    }
  });

  it("maps integration fence loss before lock resolution", async () => {
    await expect(
      createSession(
        ctx(async (command) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw cancelled(3);
        }),
        { ...session, concurrencyId: undefined },
        [],
        {
          id: "deploy",
          type: "custom-webhook",
          storageId: "custom-webhook:deploy",
          generation: "generation",
          version: 2,
          enabled: true,
        },
      ),
    ).rejects.toMatchObject({ name: "IntegrationChangedError" });
  });

  it("applies the integration fence to concurrent session admission", async () => {
    const fence = {
      id: "deploy",
      type: "custom-webhook" as const,
      storageId: "custom-webhook:deploy",
      generation: "generation",
      version: 2,
      enabled: true,
    };
    await expect(
      createSession(
        ctx(async (command) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          const items = (command as TransactWriteCommand).input.TransactItems ?? [];
          expect(
            items.some(
              (item) =>
                "ConditionCheck" in item && item.ConditionCheck?.TableName === "Integrations",
            ),
          ).toBe(true);
          return {};
        }),
        session,
        [],
        fence,
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("distinguishes lock retries, active duplicates, and stale lock collisions", async () => {
    await expect(
      createSession(
        ctx(async (command) => {
          if (command instanceof TransactWriteCommand) throw cancelled(3);
          expect(command).toBeInstanceOf(GetCommand);
          return {};
        }),
        session,
      ),
    ).rejects.toMatchObject({ name: "CreateSessionRetryExhaustedError" });

    let activeRead = false;
    await expect(
      createSession(
        ctx(async (command) => {
          if (command instanceof TransactWriteCommand) throw cancelled(3);
          expect(command).toBeInstanceOf(GetCommand);
          if (!activeRead) {
            activeRead = true;
            return { Item: { sessionId: "active" } };
          }
          return { Item: { id: "active", status: "running" } };
        }),
        session,
      ),
    ).resolves.toMatchObject({ created: false, session: { id: "active", status: "running" } });

    let calls = 0;
    await expect(
      createSession(
        ctx(async (command) => {
          calls += 1;
          if (command instanceof TransactWriteCommand) {
            if (calls === 1) throw cancelled(3);
            return {};
          }
          if (command instanceof DeleteCommand) return {};
          expect(command).toBeInstanceOf(GetCommand);
          if (calls === 2) return { Item: { sessionId: "terminal" } };
          if (calls === 3) return { Item: { id: "terminal", status: "completed" } };
          return {};
        }),
        session,
      ),
    ).resolves.toMatchObject({ created: true });
  });
});
