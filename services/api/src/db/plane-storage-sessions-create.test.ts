import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function cancelled(index: number) {
  return {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: 4 }, (_, current) => ({
      Code: current === index ? "ConditionalCheckFailed" : "None",
    })),
  };
}

describe("marker-guarded session creation", () => {
  it("does not translate non-conditional transaction failures", async () => {
    const failure = new Error("Dynamo unavailable");
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async () => {
          throw failure;
        },
      } as never,
      tables: { sessions: "Sessions", concurrencyLocks: "Locks" } as never,
    };
    await expect(
      createSession(ctx, {
        id: "session",
        repositoryId: "repo",
        prompt: "run",
        target: { commandId: "command" },
        fallbacks: [],
        targetDisplayNames: [],
        queueTtlSeconds: 1,
        queueExpiresAt: "2026-01-01T00:00:01.000Z",
        timeout: 1,
        priority: 0,
        requiredLabels: [],
        status: "queued",
        queueShard: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toBe(failure);
  });

  it("keeps a session-id collision distinct from a catalog deletion conflict", async () => {
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "None" },
              { Code: "ConditionalCheckFailed" },
            ],
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
          targetDisplayNames: [],
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

  it("classifies resource, drain, and session transaction conflicts", async () => {
    const base = {
      id: "classified",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: [],
      queueTtlSeconds: 1,
      queueExpiresAt: "2026-01-01T00:00:01.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "queued" as const,
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const attempt = (session: Record<string, unknown>, index: number) =>
      createSession(
        {
          doc: {
            send: async (command: { input?: { TableName?: string } }) =>
              command.input?.TableName === "SessionDrains"
                ? { Item: { operationId: "drain" } }
                : Promise.reject(cancelled(index)),
          } as never,
          tables: {
            sessions: "Sessions",
            repositories: "Repositories",
            workspacePools: "Pools",
            sessionDrains: "SessionDrains",
          } as never,
        },
        session as never,
      );

    await expect(attempt({ ...base, repositoryId: "repo" }, 0)).rejects.toMatchObject({
      name: "RepositoryAdmissionClosedError",
    });
    await expect(
      attempt({ ...base, repositoryId: null, workspacePoolId: "pool" }, 0),
    ).rejects.toMatchObject({
      name: "CatalogDeletionInProgressError",
    });
    await expect(
      attempt({ ...base, repositoryId: "repo", principalId: "p" }, 2),
    ).rejects.toMatchObject({ name: "SessionDrainActiveError" });
    await expect(
      attempt({ ...base, repositoryId: null, workspacePoolId: "pool" }, 1),
    ).rejects.toMatchObject({
      name: "SessionIdCollisionError",
    });
  });

  it("maps a conditional transaction with no failed condition to a catalog conflict", async () => {
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "None" },
              { Code: "ConditionalCheckFailed" },
            ],
          };
        },
      } as never,
      tables: { sessions: "Sessions", concurrencyLocks: "Locks" } as never,
    };
    await expect(
      createSession(ctx, {
        id: "session",
        repositoryId: "repo",
        prompt: "run",
        target: { commandId: "command" },
        fallbacks: [],
        targetDisplayNames: [],
        queueTtlSeconds: 1,
        queueExpiresAt: "2026-01-01T00:00:01.000Z",
        timeout: 1,
        priority: 0,
        requiredLabels: [],
        status: "queued",
        queueShard: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ name: "CatalogDeletionInProgressError" });
  });
});
