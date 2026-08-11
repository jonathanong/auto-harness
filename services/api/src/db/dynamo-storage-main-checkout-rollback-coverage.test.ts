import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { restoreMainCheckoutReconnect } from "./plane-storage-main-checkout-rollback.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhMainRollback${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local main-checkout reconnect rollback", () => {
  it("restores a prior connection and deadline exactly once", async () => {
    const opts = {
      sessionId: "deadline",
      hostId: "deadline-host",
      repositoryId: "repo",
      connectionId: "new-connection",
      previousConnectionId: "old-connection",
      previousDeadlineAt: "2026-01-01T00:01:00.000Z",
    };
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: opts.hostId,
          connectionId: opts.connectionId,
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
        },
      }),
    );
    expect(await restoreMainCheckoutReconnect(ctx, opts)).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.hostLocks, Key: { hostId: opts.hostId } }),
        )
      ).Item?.mainCheckoutLeases,
    ).toEqual({ repo: { sessionId: opts.sessionId, connectionId: opts.previousConnectionId } });
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item,
    ).toMatchObject({
      assignmentConnectionId: opts.previousConnectionId,
      reconnectDeadlineAt: opts.previousDeadlineAt,
    });
    expect(await restoreMainCheckoutReconnect(ctx, opts)).toBe(false);
  });

  it("removes an absent prior deadline and rethrows unavailable DynamoDB", async () => {
    const opts = {
      sessionId: "legacy",
      hostId: "legacy-host",
      repositoryId: "legacy-repo",
      connectionId: "current",
      previousConnectionId: "previous",
    };
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: opts.hostId,
          connectionId: opts.connectionId,
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
          reconnectDeadlineAt: "stale",
        },
      }),
    );
    expect(await restoreMainCheckoutReconnect(ctx, opts)).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item?.reconnectDeadlineAt,
    ).toBeUndefined();
    await expect(
      restoreMainCheckoutReconnect({ ...ctx, tables: { ...tables, hostLocks: "missing" } }, opts),
    ).rejects.toThrow();
  });
});
