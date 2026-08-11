import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import {
  acknowledgeSession,
  createSession,
  getWorktree,
  listAllSessions,
  listAllWorktrees,
  listSessionsByStatus,
  listWorktreesForRepo,
  releaseWorktree,
  setWorktreeOnlineFenced,
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
      expect.any(ScanCommand),
      expect.any(QueryCommand),
    ]);
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
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
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
        targetLabels: ["command"],
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

  it("treats a conditional legacy acknowledgement with no returned attributes as a failed acknowledgement", async () => {
    const commands: unknown[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof UpdateCommand) throw { name: "ConditionalCheckFailedException" };
          expect(command).toBeInstanceOf(GetCommand);
          return { Item: { id: "session", status: "running" } };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(acknowledgeSession(ctx, "session", "acknowledged")).resolves.toBe(false);
    expect(commands).toEqual([expect.any(UpdateCommand), expect.any(GetCommand)]);
  });

  it("includes optional terminal lock deletion in the exact Dynamo transaction", async () => {
    const commands: unknown[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command);
          return {};
        },
      },
      tables: { sessions: "sessions", concurrencyLocks: "locks" },
    } as unknown as PlaneStorageCtx;
    await expect(
      (await import("./plane-storage-sessions.ts")).finishSession(ctx, {
        sessionId: "session",
        attemptId: "attempt",
        status: "completed",
        queueShard: 0,
        concurrencyId: "key",
      }),
    ).resolves.toBe(true);
    expect(commands).toEqual([expect.any(TransactWriteCommand)]);
  });

  it("covers disappearing-lock retries and SDK omission response shapes", async () => {
    let transactions = 0;
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            transactions += 1;
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
            };
          }
          if (command instanceof GetCommand) return {};
          if (command instanceof UpdateCommand) return {};
          return {};
        },
      },
      tables: { sessions: "sessions", concurrencyLocks: "locks", worktrees: "worktrees" },
    } as unknown as PlaneStorageCtx;
    await expect(
      createSession(ctx, {
        id: "s",
        repositoryId: "r",
        prompt: "p",
        target: { commandId: "c" },
        fallbacks: [],
        targetLabels: [],
        queueTtlSeconds: 1,
        queueExpiresAt: "later",
        timeout: 1,
        priority: 0,
        requiredLabels: [],
        status: "queued",
        queueShard: 0,
        createdAt: "now",
        concurrencyId: "key",
      }),
    ).rejects.toThrow();
    expect(transactions).toBe(3);
    await expect(getWorktree(ctx, "missing")).resolves.toBeNull();
    await expect(
      acknowledgeSession(ctx, {
        sessionId: "s",
        worktreeId: null,
        attemptId: "a",
        acknowledgedAt: "now",
      }),
    ).resolves.toBe(true);
    await expect(releaseWorktree(ctx, "missing")).resolves.toBeUndefined();
    await expect(setWorktreeOnlineFenced(ctx, "worktree", "connection", true)).resolves.toBe(true);
  });

  it("rethrows an unavailable acknowledgement write", async () => {
    const ctx = {
      doc: { send: async () => Promise.reject(new Error("unavailable")) },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(acknowledgeSession(ctx, "session", "now")).rejects.toThrow("unavailable");
  });
});
