/* eslint-disable max-lines -- defensive SDK outcomes and queue-order fallback share one mock. */
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import {
  queueOrderKey,
  SESSIONS_QUEUE_ORDER_INDEX,
  SESSIONS_STATUS_CREATED_INDEX,
} from "../control-plane-ordering.ts";
import {
  listAllSessions,
  listAllWorktrees,
  listSessionsByStatus,
  listWorktreesForRepo,
  createSession,
  acknowledgeSession,
  cancelRunningSession,
  tryRequeueSession,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("Dynamo session adapter defensive SDK outcomes", () => {
  it("normalizes SDK responses that omit Items", async () => {
    const commands: unknown[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command);
          return {};
        },
      },
      tables: { sessions: "sessions", worktrees: "worktrees" },
    } as unknown as PlaneStorageCtx;

    await expect(listAllSessions(ctx)).resolves.toEqual([]);
    await expect(listSessionsByStatus(ctx, "queued", 0)).resolves.toEqual([]);
    await expect(listAllWorktrees(ctx)).resolves.toEqual([]);
    await expect(listWorktreesForRepo(ctx, "repo")).resolves.toEqual([]);
    expect(commands).toEqual([
      expect.any(ScanCommand),
      expect.any(QueryCommand),
      expect.any(QueryCommand),
      expect.any(ScanCommand),
      expect.any(QueryCommand),
    ]);
  });

  it("still SETs queueOrder when a requeue pre-read misses the session", async () => {
    const commands: unknown[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command);
          return {};
        },
      },
      tables: { sessions: "sessions", worktrees: "worktrees", hostLocks: "locks" },
    } as unknown as PlaneStorageCtx;
    await expect(
      tryRequeueSession(ctx, {
        sessionId: "legacy",
        worktreeId: "wt",
        attemptId: "attempt",
        queueShard: 0,
      }),
    ).resolves.toBe(true);
    const write = commands.find((command) => command instanceof TransactWriteCommand) as
      | TransactWriteCommand
      | undefined;
    const sessionUpdate = write?.input.TransactItems?.find(
      (item) => item.Update?.TableName === "sessions",
    )?.Update;
    expect(sessionUpdate?.UpdateExpression).toContain("queueOrder = :queueOrder");
    expect(sessionUpdate?.ExpressionAttributeValues?.[":queueOrder"]).toBe(
      queueOrderKey({ id: "legacy", priority: 0, createdAt: "" }),
    );
  });

  it("lists non-queued sessions from the createdAt index", async () => {
    const commands: QueryCommand[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(QueryCommand);
          commands.push(command as QueryCommand);
          return { Items: [{ id: "running", status: "running", createdAt: "t", priority: 0 }] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByStatus(ctx, "running", 0)).resolves.toMatchObject([
      { id: "running" },
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input.IndexName).toBe(SESSIONS_STATUS_CREATED_INDEX);
  });

  it("unions createdAt rows missing from the live queue-order index and repairs them", async () => {
    const commands: unknown[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof QueryCommand) {
            const index = (command as QueryCommand).input.IndexName;
            if (index === SESSIONS_QUEUE_ORDER_INDEX) {
              return {
                Items: [
                  { id: "high", status: "queued", priority: 5, createdAt: "t2", queueOrder: "x" },
                ],
              };
            }
            return {
              Items: [
                { id: "high", status: "queued", priority: 5, createdAt: "t2", queueOrder: "x" },
                { id: "low", status: "queued", priority: 0, createdAt: "t1" },
              ],
            };
          }
          return {};
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByStatus(ctx, "queued", 0)).resolves.toMatchObject([
      { id: "high" },
      { id: "low" },
    ]);
    expect(commands.some((command) => command instanceof UpdateCommand)).toBe(true);
  });

  it("skips malformed queued rows and swallows a lost queueOrder repair", async () => {
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof UpdateCommand) {
            throw { name: "ConditionalCheckFailedException" };
          }
          if ((command as QueryCommand).input.IndexName === SESSIONS_QUEUE_ORDER_INDEX) {
            return { Items: [] };
          }
          return {
            Items: [
              { id: "broken", createdAt: "t0" },
              { id: "ok", status: "queued", createdAt: "t", priority: 1 },
            ],
          };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    expect((await listSessionsByStatus(ctx, "queued", 0)).map((row) => row.id).toSorted()).toEqual([
      "broken",
      "ok",
    ]);
  });

  it("propagates unexpected queueOrder repair failures", async () => {
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof UpdateCommand) throw new Error("repair-offline");
          if ((command as QueryCommand).input.IndexName === SESSIONS_QUEUE_ORDER_INDEX) {
            return { Items: [] };
          }
          return { Items: [{ id: "ok", status: "queued", createdAt: "t", priority: 1 }] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByStatus(ctx, "queued", 0)).rejects.toThrow("repair-offline");
  });

  it("falls back to the createdAt index while the queue-order GSI is backfilling", async () => {
    const commands: unknown[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command);
          if (commands.length === 1) {
            throw Object.assign(new Error("Cannot read from backfilling global secondary index"), {
              name: "ValidationException",
            });
          }
          return {
            Items: [
              { id: "low", priority: 0, createdAt: "t1" },
              { id: "high", priority: 5, createdAt: "t2" },
            ],
          };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByStatus(ctx, "queued", 0)).resolves.toMatchObject([
      { id: "high" },
      { id: "low" },
    ]);
    expect(commands).toHaveLength(2);
  });

  it("propagates unexpected queue-order index failures", async () => {
    const ctx = {
      doc: {
        send: async () => {
          throw new Error("boom");
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByStatus(ctx, "queued", 0)).rejects.toThrow("boom");
  });

  it("retries a transaction cancellation whose lock disappears before its read", async () => {
    let transactions = 0;
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            transactions += 1;
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
            };
          }
          expect(command).toBeInstanceOf(GetCommand);
          return {};
        },
      },
      tables: { sessions: "sessions", concurrencyLocks: "locks" },
    } as unknown as PlaneStorageCtx;

    await expect(
      createSession(ctx, {
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
        status: "queued",
        queueShard: 0,
        createdAt: "now",
        concurrencyId: "key",
      }),
    ).rejects.toThrow("could not resolve concurrency lock for key");
    expect(transactions).toBe(3);
  });

  it("rejects a session collision when its simultaneously failed lock has vanished", async () => {
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [
                { Code: "None" },
                { Code: "ConditionalCheckFailed" },
                { Code: "ConditionalCheckFailed" },
              ],
            };
          }
          expect(command).toBeInstanceOf(GetCommand);
          return {};
        },
      },
      tables: { sessions: "sessions", concurrencyLocks: "locks" },
    } as unknown as PlaneStorageCtx;

    await expect(
      createSession(ctx, {
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
        status: "queued",
        queueShard: 0,
        createdAt: "now",
        concurrencyId: "key",
      }),
    ).rejects.toThrow("session id collision: session");
  });

  it("returns false for an impossible conditional legacy acknowledgement without attributes", async () => {
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof UpdateCommand) throw { name: "ConditionalCheckFailedException" };
          expect(command).toBeInstanceOf(GetCommand);
          return { Item: { id: "session", status: "running" } };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(acknowledgeSession(ctx, "session", "acknowledged")).resolves.toBe(false);
  });

  it("fences running cancellation and preserves non-conditional failures", async () => {
    const commands: UpdateCommand[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(UpdateCommand);
          commands.push(command as UpdateCommand);
          return {};
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const options = {
      sessionId: "session",
      worktreeId: "worktree",
      hostId: "host",
      connectionId: "connection",
      attemptId: "attempt",
      queueShard: 0,
      completedAt: "done",
      errorMessage: "cancelled",
    };

    await expect(cancelRunningSession(ctx, options)).resolves.toBe(true);
    await expect(
      cancelRunningSession(ctx, { ...options, drainOperationId: "drain" }),
    ).resolves.toBe(true);
    expect(commands[0]?.input.UpdateExpression).not.toContain("cancelledByDrainOperationId");
    expect(commands[1]?.input).toMatchObject({
      UpdateExpression: expect.stringContaining("cancelledByDrainOperationId"),
      ExpressionAttributeValues: { ":drainOperationId": "drain" },
    });

    const conditional = {
      ...ctx,
      doc: { send: async () => Promise.reject({ name: "ConditionalCheckFailedException" }) },
    };
    await expect(cancelRunningSession(conditional, options)).resolves.toBe(false);
    const offline = { ...ctx, doc: { send: async () => Promise.reject(new Error("offline")) } };
    await expect(cancelRunningSession(offline, options)).rejects.toThrow("offline");
  });
});
