import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { releaseMainCheckoutSession } from "./plane-storage-main-checkout-release.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhMainRelease${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local main-checkout release", () => {
  it("requeues an exact lease with every optional lifecycle field", async () => {
    const opts = {
      sessionId: "queued",
      hostId: "host",
      repositoryId: "repo",
      connectionId: "connection",
      status: "queued",
      queueShard: 2,
      reason: "retry",
      completedAt: "2026-01-01T00:01:00.000Z",
      exitCode: 0,
      errorCode: "retryable",
      cliResumeRef: "resume",
      retryCount: 0,
      retryAfter: "2026-01-01T00:02:00.000Z",
      attemptId: "attempt",
    };
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
          statusShard: "running#2",
          hostId: opts.hostId,
          assignmentConnectionId: opts.connectionId,
          mainCheckoutLease: true,
          attemptId: opts.attemptId,
          worktreeId: null,
          startedAt: "started",
          assignmentSentAt: "sent",
          reconnectDeadlineAt: "deadline",
          ackReceivedAt: "ack",
        },
      }),
    );
    expect(await releaseMainCheckoutSession(ctx, opts)).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item,
    ).toMatchObject({
      status: "queued",
      statusShard: "queued#2",
      hostId: null,
      worktreeId: null,
      errorMessage: opts.reason,
      completedAt: opts.completedAt,
      exitCode: 0,
      errorCode: opts.errorCode,
      cliResumeRef: opts.cliResumeRef,
      retryCount: 0,
      retryAfter: opts.retryAfter,
    });
    expect(await releaseMainCheckoutSession(ctx, opts)).toBe(false);
  });

  it("finishes a cancelled session, releases its concurrency lock, and rethrows outages", async () => {
    const opts = {
      sessionId: "finished",
      hostId: "finished-host",
      repositoryId: "finished-repo",
      connectionId: "finished-connection",
      status: "completed",
      queueShard: 1,
      expectedStatus: "cancelled" as const,
      concurrencyId: "concurrency",
    };
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
          status: "cancelled",
          statusShard: "cancelled#1",
          hostId: opts.hostId,
          assignmentConnectionId: opts.connectionId,
          mainCheckoutLease: true,
          worktreeId: null,
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.concurrencyLocks,
        Item: { concurrencyId: opts.concurrencyId, sessionId: opts.sessionId },
      }),
    );
    expect(await releaseMainCheckoutSession(ctx, opts)).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item,
    ).toMatchObject({
      status: "completed",
      statusShard: "completed#1",
      hostId: opts.hostId,
      worktreeId: null,
    });
    expect(
      (
        await ctx.doc.send(
          new GetCommand({
            TableName: tables.concurrencyLocks,
            Key: { concurrencyId: opts.concurrencyId },
          }),
        )
      ).Item,
    ).toBeUndefined();
    await expect(
      releaseMainCheckoutSession({ ...ctx, tables: { ...tables, hostLocks: "missing" } }, opts),
    ).rejects.toThrow();
  });
});
