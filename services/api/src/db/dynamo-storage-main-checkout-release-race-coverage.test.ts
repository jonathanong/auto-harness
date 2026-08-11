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
  tables = await ensureControlPlaneTables({ client, prefix: `AhReleaseRace${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local main-checkout release races", () => {
  it("does not release another session's replacement lease", async () => {
    const opts = {
      sessionId: "stale-session",
      hostId: "stale-host",
      repositoryId: "stale-repo",
      connectionId: "connection",
      status: "completed",
      queueShard: 0,
    };
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: opts.hostId,
          mainCheckoutLeases: {
            [opts.repositoryId]: { sessionId: "replacement", connectionId: opts.connectionId },
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
          worktreeId: null,
        },
      }),
    );
    expect(await releaseMainCheckoutSession(ctx, opts)).toBe(false);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: opts.sessionId } }),
        )
      ).Item?.status,
    ).toBe("running");
  });
});
