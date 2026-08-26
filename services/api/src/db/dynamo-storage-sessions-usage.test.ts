import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  getSession,
  putSession,
  putWorktree,
  requeueUsageLimitedSession,
  suppressProviderlessUsageLimit,
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
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "later",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  queueShard: 0,
  createdAt: "now",
};
beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Usage${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local usage limit transitions", () => {
  it("pauses an account and persists a providerless target suppression", async () => {
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.providerAccounts,
        Item: {
          id: "account",
          providerId: "provider",
          name: "account",
          createdAt: "now",
          updatedAt: "now",
        },
      }),
    );
    await putSession(ctx, {
      ...base,
      id: "limited",
      status: "running",
      worktreeId: "limited-wt",
      attemptId: "attempt",
    });
    await putWorktree(ctx, {
      id: "limited-wt",
      name: "limited",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "limited",
    });
    expect(
      await requeueUsageLimitedSession(ctx, {
        sessionId: "limited",
        worktreeId: "limited-wt",
        attemptId: "attempt",
        providerAccountId: "account",
        queueShard: 0,
        now: "now",
        usageLimitedUntil: "later",
      }),
    ).toBe(true);
    expect(
      await requeueUsageLimitedSession(ctx, {
        sessionId: "limited",
        worktreeId: "limited-wt",
        attemptId: "wrong",
        providerAccountId: "account",
        queueShard: 0,
        now: "now",
        usageLimitedUntil: "later",
      }),
    ).toBe(false);
    await putSession(ctx, {
      ...base,
      id: "suppressed",
      status: "running",
      worktreeId: "suppressed-wt",
      attemptId: "attempt",
    });
    await putWorktree(ctx, {
      id: "suppressed-wt",
      name: "suppressed",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "suppressed",
    });
    expect(
      await suppressProviderlessUsageLimit(ctx, {
        sessionId: "suppressed",
        worktreeId: "suppressed-wt",
        attemptId: "attempt",
        queueShard: 0,
        targetIndex: 1,
      }),
    ).toBe(true);
    expect((await getSession(ctx, "suppressed"))?.suppressedTargetIndexes).toEqual([1]);
    expect(
      await suppressProviderlessUsageLimit(ctx, {
        sessionId: "suppressed",
        worktreeId: "suppressed-wt",
        attemptId: "wrong",
        queueShard: 0,
        targetIndex: 1,
      }),
    ).toBe(false);
  });
});
