import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import { finishSession, getSession, putSession } from "./plane-storage-sessions.ts";
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
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Finish${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local terminal options", () => {
  it("queues an exact fenced running session with all optional terminal fields", async () => {
    await putSession(ctx, {
      ...base,
      id: "session",
      status: "running",
      worktreeId: null,
      hostId: "host",
      attemptId: "attempt",
      reconnectDeadlineAt: "deadline",
      assignmentConnectionId: "connection",
    });
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await finishSession(ctx, {
        sessionId: "session",
        worktreeId: null,
        attemptId: "attempt",
        status: "queued",
        queueShard: 0,
        completedAt: "done",
        errorCode: "retry",
        errorMessage: "retry",
        exitCode: null,
        cliResumeRef: "opaque",
        fence: { hostId: "host", connectionId: "connection" },
      }),
    ).toBe(true);
    expect((await getSession(ctx, "session"))?.status).toBe("queued");
  });
});
