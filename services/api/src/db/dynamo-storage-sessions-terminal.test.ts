import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
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
    expect(
      await finishSession(ctx, {
        sessionId: "finish",
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "completed",
        queueShard: 0,
      }),
    ).toBe(true);
    await putSession(ctx, { ...base, id: "expire", status: "queued" });
    expect(
      await expireQueuedSession(ctx, {
        sessionId: "expire",
        queueShard: 0,
        queueExpiresAt: "wrong",
        completedAt: "done",
      }),
    ).toBe(false);
    expect(
      await expireQueuedSession(ctx, {
        sessionId: "expire",
        queueShard: 0,
        queueExpiresAt: base.queueExpiresAt,
        completedAt: "done",
      }),
    ).toBe(true);
  });
});
