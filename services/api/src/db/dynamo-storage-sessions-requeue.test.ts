import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import {
  acknowledgeSession,
  getSession,
  getWorktree,
  putSession,
  putWorktree,
  tryRequeueSession,
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
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Requeue${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local requeue and acknowledgement races", () => {
  it("requeues only the exact running attempt and can fence a reconnect", async () => {
    await putSession(ctx, {
      ...base,
      id: "run",
      status: "running",
      worktreeId: "wt",
      hostId: "host",
      attemptId: "attempt",
      assignmentConnectionId: "connection",
      reconnectDeadlineAt: "deadline",
    });
    await putWorktree(ctx, {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "run",
      connectionId: "connection",
    });
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "run",
        worktreeId: "wt",
        attemptId: "wrong",
        queueShard: 0,
      }),
    ).toBe(false);
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "run",
        worktreeId: "wt",
        attemptId: "attempt",
        queueShard: 0,
        reason: "reconnect",
        forceOffline: true,
        expectedHostId: "host",
        expectedReconnectDeadlineAt: "deadline",
        expectedConnectionId: "connection",
        nextConnectionId: "next",
        requireUnacknowledged: true,
      }),
    ).toBe(true);
    expect((await getSession(ctx, "run"))?.status).toBe("queued");
    expect((await getWorktree(ctx, "wt"))?.online).toBe(false);
    await putSession(ctx, {
      ...base,
      id: "fenced",
      status: "running",
      worktreeId: "fenced-wt",
      hostId: "fenced-host",
      attemptId: "attempt",
    });
    await putWorktree(ctx, {
      id: "fenced-wt",
      name: "fenced",
      hostId: "fenced-host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "fenced",
    });
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "fenced",
        worktreeId: "fenced-wt",
        attemptId: "attempt",
        queueShard: 0,
        fence: { hostId: "fenced-host", connectionId: "missing" },
        requireNoHostLock: "free-host",
      }),
    ).toBe(false);
    await expect(
      tryRequeueSession(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { sessionId: "fenced", worktreeId: "fenced-wt", attemptId: "attempt", queueShard: 0 },
      ),
    ).rejects.toThrow();
  });

  it("acknowledges an exact attempt, accepts its duplicate, and rejects a stale lease", async () => {
    await putSession(ctx, {
      ...base,
      id: "ack",
      status: "running",
      worktreeId: "ack-wt",
      hostId: "ack-host",
      attemptId: "attempt",
      assignmentConnectionId: "connection",
      assignmentSentAt: "sent",
    });
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "ack-host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, {
        sessionId: "ack",
        worktreeId: "ack-wt",
        attemptId: "attempt",
        acknowledgedAt: "ack",
        fence: { hostId: "ack-host", connectionId: "connection" },
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, {
        sessionId: "ack",
        worktreeId: "ack-wt",
        attemptId: "attempt",
        acknowledgedAt: "again",
        fence: { hostId: "ack-host", connectionId: "connection" },
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, "ack", "again", {
        hostId: "ack-host",
        connectionId: "connection",
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, "ack", "again", { hostId: "ack-host", connectionId: "wrong" }),
    ).toBe(false);
    await putSession(ctx, { ...base, id: "legacy", status: "running" });
    expect(await acknowledgeSession(ctx, "legacy", "ack")).toBe(true);
    expect(await acknowledgeSession(ctx, "legacy", "again")).toBe(true);
    expect(await acknowledgeSession(ctx, "missing", "ack")).toBe(true);
    await putSession(ctx, {
      ...base,
      id: "modern",
      status: "running",
      worktreeId: "modern-wt",
      attemptId: "attempt",
      assignmentSentAt: "sent",
    });
    expect(
      await acknowledgeSession(ctx, {
        sessionId: "modern",
        worktreeId: "modern-wt",
        attemptId: "attempt",
        acknowledgedAt: "ack",
      }),
    ).toBe(true);
  });
});
