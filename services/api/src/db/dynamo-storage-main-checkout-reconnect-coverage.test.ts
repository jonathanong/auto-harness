import {
  DeleteTableCommand,
  ListTablesCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  confirmMainCheckoutReconnect,
  markMainCheckoutReconnectPending,
} from "./plane-storage-main-checkout-reconnect.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;
let available = false;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  try {
    await client.send(new ListTablesCommand({}));
    tables = await ensureControlPlaneTables({
      client,
      prefix: `AhMainReconnect${process.pid}${Date.now()}`,
    });
    ctx = { doc: clients.doc, tables };
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (!available) return;
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local main-checkout reconnect transactions", () => {
  it("allows only one pending mark in a real conditional race", async () => {
    if (!available) return;
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: "mark-host",
          connectionId: "mark-connection",
          mainCheckoutLeases: {
            "mark-repository": { sessionId: "mark-session", connectionId: "mark-connection" },
          },
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: {
          id: "mark-session",
          status: "running",
          hostId: "mark-host",
          assignmentConnectionId: "mark-connection",
          mainCheckoutLease: true,
        },
      }),
    );

    const opts = {
      sessionId: "mark-session",
      hostId: "mark-host",
      repositoryId: "mark-repository",
      connectionId: "mark-connection",
      deadlineAt: "2026-01-01T00:01:00.000Z",
    };
    const results = await Promise.all([
      markMainCheckoutReconnectPending(ctx, opts),
      markMainCheckoutReconnectPending(ctx, opts),
    ]);
    expect(results.toSorted()).toEqual([false, true]);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item?.reconnectDeadlineAt,
    ).toBe(opts.deadlineAt);
    expect(
      await markMainCheckoutReconnectPending(ctx, { ...opts, connectionId: "stale-connection" }),
    ).toBe(false);
  });

  it("confirms a reconnect once, with and without the observed deadline", async () => {
    if (!available) return;
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: "confirm-host",
          connectionId: "confirm-new",
          mainCheckoutLeases: {
            "confirm-repository": { sessionId: "confirm-session", connectionId: "confirm-old" },
          },
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: {
          id: "confirm-session",
          status: "running",
          hostId: "confirm-host",
          assignmentConnectionId: "confirm-old",
          mainCheckoutLease: true,
          ackReceivedAt: "2026-01-01T00:00:00.000Z",
          reconnectDeadlineAt: "2026-01-01T00:01:00.000Z",
        },
      }),
    );
    const opts = {
      sessionId: "confirm-session",
      hostId: "confirm-host",
      repositoryId: "confirm-repository",
      oldConnectionId: "confirm-old",
      connectionId: "confirm-new",
      deadlineAt: "2026-01-01T00:01:00.000Z",
    };
    expect(await confirmMainCheckoutReconnect(ctx, opts)).toBe(true);
    expect(await confirmMainCheckoutReconnect(ctx, opts)).toBe(false);

    const item = (
      await ctx.doc.send(
        new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
      )
    ).Item;
    expect(item).toMatchObject({ assignmentConnectionId: opts.connectionId });
    expect(item?.reconnectDeadlineAt).toBeUndefined();
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.hostLocks, Key: { hostId: opts.hostId } }),
        )
      ).Item?.mainCheckoutLeases,
    ).toMatchObject({
      [opts.repositoryId]: {
        sessionId: opts.sessionId,
        connectionId: opts.connectionId,
      },
    });

    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: "legacy-confirm-host",
          connectionId: "legacy-new",
          mainCheckoutLeases: {
            "legacy-confirm-repository": {
              sessionId: "legacy-confirm-session",
              connectionId: "legacy-old",
            },
          },
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: {
          id: "legacy-confirm-session",
          status: "running",
          hostId: "legacy-confirm-host",
          assignmentConnectionId: "legacy-old",
          mainCheckoutLease: true,
          ackReceivedAt: "2026-01-01T00:00:00.000Z",
          reconnectDeadlineAt: "stale-deadline",
        },
      }),
    );
    expect(
      await confirmMainCheckoutReconnect(ctx, {
        sessionId: "legacy-confirm-session",
        hostId: "legacy-confirm-host",
        repositoryId: "legacy-confirm-repository",
        oldConnectionId: "legacy-old",
        connectionId: "legacy-new",
      }),
    ).toBe(true);
  });

  it("rethrows a real DynamoDB outage rather than reporting a race loss", async () => {
    if (!available) return;
    const unavailable = { ...ctx, tables: { ...tables, hostLocks: "missing-reconnect-table" } };
    await expect(
      markMainCheckoutReconnectPending(unavailable, {
        sessionId: "missing",
        hostId: "missing",
        repositoryId: "missing",
        connectionId: "missing",
        deadlineAt: "deadline",
      }),
    ).rejects.toThrow();
    await expect(
      confirmMainCheckoutReconnect(unavailable, {
        sessionId: "missing",
        hostId: "missing",
        repositoryId: "missing",
        oldConnectionId: "old",
        connectionId: "new",
      }),
    ).rejects.toThrow();
  });
});
