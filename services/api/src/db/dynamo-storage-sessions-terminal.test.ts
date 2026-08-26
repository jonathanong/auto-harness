import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  expireQueuedSession,
  finishSession,
  getWorktree,
  putSession,
  putWorktree,
} from "./plane-storage-sessions.ts";
import { sessionDrainActivityKey, sessionDrainScopeKey } from "./plane-storage-session-drains.ts";
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
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Terminal${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local terminal session lifecycle", () => {
  it("finishes one exact running assignment and conditionally expires queued work", async () => {
    await putSession(ctx, {
      ...base,
      id: "finish",
      principalId: "principal",
      status: "running",
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
      currentSessionId: "finish",
    });
    await putActivity("finish");
    expect(
      await finishSession(ctx, {
        sessionId: "finish",
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "completed",
        queueShard: 0,
        completedAt: "done",
        errorCode: "none",
        errorMessage: "none",
        exitCode: 0,
        cliResumeRef: "opaque",
      }),
    ).toBe(true);
    expect((await getWorktree(ctx, "worktree"))?.status).toBe("idle");
    await expect(getActivity("finish")).resolves.toBeUndefined();
    expect(
      await finishSession(ctx, {
        sessionId: "finish",
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "completed",
        queueShard: 0,
      }),
    ).toBe(true);
    await putSession(ctx, { ...base, id: "expire", principalId: "principal", status: "queued" });
    await putActivity("expire");
    expect(
      await expireQueuedSession(ctx, {
        sessionId: "expire",
        queueShard: 0,
        queueExpiresAt: "wrong",
        completedAt: "done",
      }),
    ).toBe(false);
    await expect(getActivity("expire")).resolves.toBeDefined();
    expect(
      await expireQueuedSession(ctx, {
        sessionId: "expire",
        queueShard: 0,
        queueExpiresAt: base.queueExpiresAt,
        completedAt: "done",
      }),
    ).toBe(true);
    await expect(getActivity("expire")).resolves.toBeUndefined();
  });
});

async function putActivity(sessionId: string): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: tables.sessionDrains,
      Item: {
        scopeKey: sessionDrainScopeKey("repo", "principal"),
        recordKey: sessionDrainActivityKey(sessionId),
        recordType: "activity",
        sessionId,
        repositoryId: "repo",
        principalId: "principal",
      },
    }),
  );
}

async function getActivity(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const result = await ctx.doc.send(
    new GetCommand({
      TableName: tables.sessionDrains,
      Key: {
        scopeKey: sessionDrainScopeKey("repo", "principal"),
        recordKey: sessionDrainActivityKey(sessionId),
      },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}
