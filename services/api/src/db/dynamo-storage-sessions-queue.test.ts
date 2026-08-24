/* eslint-disable max-lines -- queued pin, cancel, and expiry lock cases share one Dynamo fixture. */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import {
  cancelQueuedSession,
  clearResumePin,
  expireQueuedSession,
  failExpiredResumeSession,
  getConcurrencyLock,
  getSession,
  getWorktree,
  putSession,
  putWorktree,
  releaseCancelledSessionWorktree,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;
const base = {
  repositoryId: "repo",
  prompt: "prompt",
  target: { commandId: "command" },
  fallbacks: [],
  targetLabels: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T01:00:00.000Z",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Queue${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local queued session lifecycle", () => {
  it("expires a matching resume pin and only releases the lock it owns", async () => {
    await putSession(ctx, { ...base, id: "pinned", status: "queued", pinExpiresAt: "pin" });
    expect(
      await failExpiredResumeSession(ctx, {
        sessionId: "pinned",
        queueShard: 0,
        pinExpiresAt: "wrong",
      }),
    ).toBe(false);
    expect(
      await failExpiredResumeSession(ctx, {
        sessionId: "pinned",
        queueShard: 0,
        pinExpiresAt: "pin",
        concurrencyId: "none",
      }),
    ).toBe(true);
    expect((await getSession(ctx, "pinned"))?.errorCode).toBe("resume_failed");
    await putSession(ctx, {
      ...base,
      id: "clear",
      status: "queued",
      pinnedHostId: "host",
      pinExpiresAt: "pin",
      pinnedProviderAccountId: "account",
      pinnedTargetIndex: 0,
      pinnedCommandId: "command",
      cliResumeRef: "opaque",
    });
    expect(await clearResumePin(ctx, { sessionId: "clear", pinnedHostId: "wrong" })).toBe(false);
    expect(
      await clearResumePin(ctx, { sessionId: "clear", pinnedHostId: "host", pinExpiresAt: "pin" }),
    ).toBe(true);
    expect(await clearResumePin(ctx, { sessionId: "clear", pinnedHostId: "host" })).toBe(false);
    expect((await getSession(ctx, "clear"))?.resumeFallback).toBe(true);
    await expect(
      failExpiredResumeSession(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { sessionId: "missing", queueShard: 0, pinExpiresAt: "pin" },
      ),
    ).rejects.toThrow();
    await expect(
      clearResumePin(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { sessionId: "missing", pinnedHostId: "host" },
      ),
    ).rejects.toThrow();
  });

  it("cancels only a queued owner and releases a matching cancelled assignment", async () => {
    await putSession(ctx, {
      ...base,
      id: "cancel",
      status: "queued",
      concurrencyId: "cancel-lock",
    });
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.concurrencyLocks,
        Item: { concurrencyId: "cancel-lock", sessionId: "cancel" },
      }),
    );
    expect(
      await cancelQueuedSession(ctx, {
        sessionId: "cancel",
        queueShard: 0,
        completedAt: "done",
        errorMessage: "cancelled",
        concurrencyId: "cancel-lock",
      }),
    ).toBe(true);
    expect(await getConcurrencyLock(ctx, "cancel-lock")).toBeNull();
    expect(
      await cancelQueuedSession(ctx, {
        sessionId: "cancel",
        queueShard: 0,
        completedAt: "again",
        errorMessage: "cancelled",
      }),
    ).toBe(false);
    await putSession(ctx, {
      ...base,
      id: "cancelled",
      status: "cancelled",
      worktreeId: "worktree",
      attemptId: "attempt",
    });
    await putWorktree(ctx, {
      id: "worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "cancelled",
      connectionId: "connection",
    });
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await releaseCancelledSessionWorktree(ctx, {
        sessionId: "cancelled",
        worktreeId: "worktree",
        attemptId: "attempt",
        online: true,
        cliResumeRef: "opaque",
        fence: { hostId: "host", connectionId: "connection" },
        concurrencyId: "none",
      }),
    ).toBe(true);
    expect((await getWorktree(ctx, "worktree"))?.status).toBe("idle");
    expect(
      await releaseCancelledSessionWorktree(ctx, {
        sessionId: "cancelled",
        worktreeId: "worktree",
        attemptId: "attempt",
        online: true,
      }),
    ).toBe(true);
    await expect(
      cancelQueuedSession(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { sessionId: "missing", queueShard: 0, completedAt: "done", errorMessage: "cancelled" },
      ),
    ).rejects.toThrow();
    await expect(
      releaseCancelledSessionWorktree(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { sessionId: "missing", worktreeId: "worktree", attemptId: "attempt", online: true },
      ),
    ).rejects.toThrow();
  });

  it("expires a queued session and releases the concurrency lease it owns", async () => {
    await putSession(ctx, {
      ...base,
      id: "expire-lock",
      status: "queued",
      concurrencyId: "expire-lock",
    });
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.concurrencyLocks,
        Item: { concurrencyId: "expire-lock", sessionId: "expire-lock" },
      }),
    );
    expect(
      await expireQueuedSession(ctx, {
        sessionId: "expire-lock",
        queueShard: 0,
        queueExpiresAt: base.queueExpiresAt,
        completedAt: "done",
        concurrencyId: "expire-lock",
      }),
    ).toBe(true);
    expect((await getSession(ctx, "expire-lock"))?.errorCode).toBe("queue_expired");
    expect(await getConcurrencyLock(ctx, "expire-lock")).toBeNull();
  });
});
