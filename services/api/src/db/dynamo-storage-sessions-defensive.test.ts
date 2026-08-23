import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import {
  listAllSessions,
  listAllWorktrees,
  listSessionsByStatus,
  listWorktreesForRepo,
  createSession,
  acknowledgeSession,
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
});
