import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { requeueMainCheckoutUsageLimitedSession } from "./plane-storage-main-checkout-usage-limit.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;
const now = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhUsageLimit${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local main-checkout usage-limit release", () => {
  it("cools an account, requeues the exact lease, and rejects a stale retry", async () => {
    const opts = {
      sessionId: "limited",
      hostId: "host",
      repositoryId: "repo",
      connectionId: "connection",
      attemptId: "attempt",
      providerAccountId: "account",
      queueShard: 3,
      now,
      usageLimitedUntil: "2026-01-01T01:00:00.000Z",
      errorMessage: "rate limited",
    };
    await ctx.doc.send(
      new PutCommand({ TableName: tables.providerAccounts, Item: { id: opts.providerAccountId } }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: opts.hostId,
          mainCheckoutLeases: {
            [opts.repositoryId]: { sessionId: opts.sessionId, connectionId: opts.connectionId },
          },
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: {
          id: opts.sessionId,
          status: "running",
          statusShard: "running#3",
          hostId: opts.hostId,
          assignmentConnectionId: opts.connectionId,
          mainCheckoutLease: true,
          attemptId: opts.attemptId,
        },
      }),
    );

    expect(await requeueMainCheckoutUsageLimitedSession(ctx, opts)).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({
            TableName: tables.providerAccounts,
            Key: { id: opts.providerAccountId },
          }),
        )
      ).Item,
    ).toMatchObject({
      usageLimitedUntil: opts.usageLimitedUntil,
      lastUsageLimitedAt: now,
      updatedAt: now,
    });
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.hostLocks, Key: { hostId: opts.hostId } }),
        )
      ).Item?.mainCheckoutLeases,
    ).toEqual({});
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item,
    ).toMatchObject({
      status: "queued",
      statusShard: "queued#3",
      errorCode: "usage_limit",
      errorMessage: opts.errorMessage,
      hostId: null,
      worktreeId: null,
      queueOrder: expect.any(String),
    });
    expect(await requeueMainCheckoutUsageLimitedSession(ctx, opts)).toBe(false);
  });

  it("uses the default message and rethrows an unavailable table", async () => {
    const opts = {
      sessionId: "default-message",
      hostId: "default-host",
      repositoryId: "default-repo",
      connectionId: "default-connection",
      attemptId: "default-attempt",
      providerAccountId: "default-account",
      queueShard: 0,
      now,
      usageLimitedUntil: "2026-01-01T01:00:00.000Z",
    };
    await ctx.doc.send(
      new PutCommand({ TableName: tables.providerAccounts, Item: { id: opts.providerAccountId } }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: opts.hostId,
          mainCheckoutLeases: {
            [opts.repositoryId]: { sessionId: opts.sessionId, connectionId: opts.connectionId },
          },
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: {
          id: opts.sessionId,
          status: "running",
          statusShard: "running#0",
          hostId: opts.hostId,
          assignmentConnectionId: opts.connectionId,
          mainCheckoutLease: true,
          attemptId: opts.attemptId,
        },
      }),
    );
    expect(await requeueMainCheckoutUsageLimitedSession(ctx, opts)).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item?.errorMessage,
    ).toBe("provider usage limit; requeued");
    await expect(
      requeueMainCheckoutUsageLimitedSession(
        { ...ctx, tables: { ...tables, providerAccounts: "missing" } },
        opts,
      ),
    ).rejects.toThrow();
  });
});
