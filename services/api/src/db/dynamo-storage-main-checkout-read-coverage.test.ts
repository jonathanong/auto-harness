import {
  DeleteTableCommand,
  ListTablesCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { getMainCheckoutCursor, getMainCheckoutLease } from "./plane-storage-main-checkout-read.ts";
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
      prefix: `AhMainRead${process.pid}${Date.now()}`,
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

describe("DynamoDB Local main-checkout reads", () => {
  it("reads the cursor and an exact repository lease", async () => {
    if (!available) return;
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: "read-host",
          lastScheduledAssignedAt: "2026-01-01T00:00:00.000Z",
          mainCheckoutLeases: {
            "read-repository": { sessionId: "read-session", connectionId: "read-connection" },
          },
        },
      }),
    );

    expect(await getMainCheckoutCursor(ctx, "read-host")).toBe("2026-01-01T00:00:00.000Z");
    expect(await getMainCheckoutLease(ctx, "read-host", "read-repository")).toEqual({
      sessionId: "read-session",
      connectionId: "read-connection",
    });
  });

  it("returns null for missing hosts, absent attributes, and malformed lease values", async () => {
    if (!available) return;
    expect(await getMainCheckoutCursor(ctx, "missing-read-host")).toBeNull();
    expect(await getMainCheckoutLease(ctx, "missing-read-host", "read-repository")).toBeNull();

    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: { hostId: "empty-read-host", mainCheckoutLeases: {} },
      }),
    );
    expect(await getMainCheckoutCursor(ctx, "empty-read-host")).toBeNull();
    expect(await getMainCheckoutLease(ctx, "empty-read-host", "read-repository")).toBeNull();

    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: "malformed-read-host",
          mainCheckoutLeases: {
            primitive: "not-a-lease",
            empty: {},
            missingConnectionId: { sessionId: "read-session" },
            nonStringSessionId: { sessionId: 1, connectionId: "read-connection" },
            nonStringConnectionId: { sessionId: "read-session", connectionId: 1 },
          },
        },
      }),
    );
    await expect(getMainCheckoutLease(ctx, "malformed-read-host", "primitive")).resolves.toBeNull();
    await expect(getMainCheckoutLease(ctx, "malformed-read-host", "empty")).resolves.toBeNull();
    await expect(
      getMainCheckoutLease(ctx, "malformed-read-host", "missingConnectionId"),
    ).resolves.toBeNull();
    await expect(
      getMainCheckoutLease(ctx, "malformed-read-host", "nonStringSessionId"),
    ).resolves.toBeNull();
    await expect(
      getMainCheckoutLease(ctx, "malformed-read-host", "nonStringConnectionId"),
    ).resolves.toBeNull();
  });

  it("rethrows a real DynamoDB resource failure", async () => {
    if (!available) return;
    await expect(
      getMainCheckoutCursor(
        { ...ctx, tables: { ...tables, hostLocks: "missing-main-read-table" } },
        "read-host",
      ),
    ).rejects.toThrow();
    await expect(
      getMainCheckoutLease(
        { ...ctx, tables: { ...tables, hostLocks: "missing-main-read-table" } },
        "read-host",
        "read-repository",
      ),
    ).rejects.toThrow();
  });
});
