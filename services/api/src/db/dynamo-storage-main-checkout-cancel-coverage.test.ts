import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { listPendingCancelRedeliveries } from "./plane-storage-cancel-redeliveries.ts";
import { cancelRunningMainCheckoutSession } from "./plane-storage-main-checkout-cancel.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhMainCancel${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local main-checkout cancellation", () => {
  it("cancels only the exact running attempt", async () => {
    const opts = {
      sessionId: "cancelled",
      hostId: "host",
      connectionId: "connection",
      attemptId: "attempt",
      queueShard: 4,
      completedAt: "2026-01-01T00:01:00.000Z",
      deadlineAt: "2026-01-01T00:02:00.000Z",
      errorMessage: "cancelled by operator",
    };
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: {
          id: opts.sessionId,
          status: "running",
          statusShard: "running#4",
          hostId: opts.hostId,
          assignmentConnectionId: opts.connectionId,
          attemptId: opts.attemptId,
          worktreeId: null,
          mainCheckoutLease: true,
        },
      }),
    );
    expect(await cancelRunningMainCheckoutSession(ctx, opts)).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item,
    ).toMatchObject({
      status: "cancelled",
      statusShard: "cancelled#4",
      completedAt: opts.completedAt,
      reconnectDeadlineAt: opts.deadlineAt,
      errorMessage: opts.errorMessage,
    });
    expect(await listPendingCancelRedeliveries(ctx, 10)).toEqual([
      expect.objectContaining({
        sessionId: opts.sessionId,
        hostId: opts.hostId,
        attemptId: opts.attemptId,
        status: "pending",
        attempts: 0,
        createdAt: opts.completedAt,
        queuedAt: opts.completedAt,
      }),
    ]);
    expect(await cancelRunningMainCheckoutSession(ctx, opts)).toBe(false);
  });

  it("rethrows a real unavailable-table error", async () => {
    await expect(
      cancelRunningMainCheckoutSession(
        { ...ctx, tables: { ...tables, sessions: "missing" } },
        {
          sessionId: "missing",
          hostId: "host",
          connectionId: "connection",
          attemptId: "attempt",
          queueShard: 0,
          completedAt: "now",
          deadlineAt: "later",
          errorMessage: "message",
        },
      ),
    ).rejects.toThrow();
  });
});
