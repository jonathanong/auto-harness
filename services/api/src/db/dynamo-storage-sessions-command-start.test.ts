import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import { authorizePrimaryCommandStart } from "./plane-storage-sessions-command-start.ts";
import { getSession, putSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhCommandStart${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local primary command-start authorization", () => {
  it("commits under its host fence, accepts an exact replay, and rejects stale attempts", async () => {
    await putSession(ctx, {
      id: "session",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T01:00:00.000Z",
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "worktree",
      attemptId: "attempt",
      assignmentConnectionId: "connection",
      primaryCommandStartState: "pending",
    });
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).toBe(true);
    const commandStart = {
      sessionId: "session",
      worktreeId: "worktree",
      attemptId: "attempt",
      fence: { hostId: "host", connectionId: "connection" },
    };

    expect(await authorizePrimaryCommandStart(ctx, commandStart)).toBe(true);
    expect((await getSession(ctx, "session"))?.primaryCommandStartState).toBe("authorized");
    expect(await authorizePrimaryCommandStart(ctx, commandStart)).toBe(true);
    expect(await authorizePrimaryCommandStart(ctx, { ...commandStart, attemptId: "stale" })).toBe(
      false,
    );
    expect(
      await authorizePrimaryCommandStart(ctx, {
        ...commandStart,
        fence: { hostId: "host", connectionId: "stale-connection" },
      }),
    ).toBe(false);
  });

  it("authorizes without a host fence and propagates unexpected storage failures", async () => {
    await putSession(ctx, {
      id: "unfenced-session",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T01:00:00.000Z",
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "worktree",
      attemptId: "attempt",
      primaryCommandStartState: "pending",
    });

    expect(
      await authorizePrimaryCommandStart(ctx, {
        sessionId: "unfenced-session",
        worktreeId: "worktree",
        attemptId: "attempt",
      }),
    ).toBe(true);

    const storageError = new Error("storage unavailable");
    const failingCtx = {
      ...ctx,
      doc: { send: async () => Promise.reject(storageError) },
    } as unknown as PlaneStorageCtx;
    await expect(
      authorizePrimaryCommandStart(failingCtx, {
        sessionId: "unfenced-session",
        worktreeId: "worktree",
        attemptId: "attempt",
      }),
    ).rejects.toBe(storageError);
  });
});
