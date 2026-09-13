import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import { getWorktree, putSession, putWorktree } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let storage: DynamoPlaneStorageBase;
let tables: DynamoTableNames;

const base = {
  repositoryId: "repo",
  prompt: "prompt",
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-02T00:00:00.000Z",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhHandoffWt${process.pid}` });
  ctx = { doc: clients.doc, tables };
  storage = new DynamoPlaneStorageBase(clients.doc, tables);
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB terminal-hook worktree reservation", () => {
  it("reserves a handoff worktree until the hook settles or expires", async () => {
    const worktree = {
      id: "reserved-worktree",
      name: "reserved-worktree",
      hostId: "reserved-host",
      repositoryId: "repo",
      path: "/repo/reserved",
      labels: [],
      status: "busy" as const,
      online: true,
      currentSessionId: "reserved-settle",
    };
    const handoff = {
      handoffId: "handoff",
      hostId: "reserved-host",
      repositoryId: "repo",
      worktreeId: worktree.id,
      status: "failed" as const,
      errorCode: "host_lost" as const,
      expiresAt: "2026-01-02T00:00:00.000Z",
    };
    await putSession(ctx, {
      ...base,
      id: "reserved-settle",
      status: "running",
      worktreeId: worktree.id,
      hostId: "reserved-host",
      attemptId: "attempt",
    });
    await putWorktree(ctx, worktree);
    await expect(
      storage.finishSession({
        sessionId: "reserved-settle",
        worktreeId: worktree.id,
        attemptId: "attempt",
        status: "failed",
        queueShard: 0,
        terminalHookHandoff: handoff,
      }),
    ).resolves.toBe(true);
    await expect(getWorktree(ctx, worktree.id)).resolves.toMatchObject({
      status: "busy",
      currentSessionId: "reserved-settle",
    });
    await expect(
      tryAcquireHostLock(ctx, {
        hostId: "reserved-host",
        connectionId: "reserved-connection",
        replaceExisting: false,
      }),
    ).resolves.toBe(true);
    await expect(
      storage.settleTerminalHookHandoff({
        sessionId: "reserved-settle",
        handoffId: handoff.handoffId,
        hostId: "reserved-host",
        connectionId: "reserved-connection",
        worktreeId: worktree.id,
      }),
    ).resolves.toBe(true);
    await expect(getWorktree(ctx, worktree.id)).resolves.toMatchObject({
      status: "idle",
      currentSessionId: null,
      online: true,
      connectionId: "reserved-connection",
    });

    const expiringWorktree = { ...worktree, id: "expiring-worktree", currentSessionId: "expired" };
    const expiringHandoff = {
      ...handoff,
      handoffId: "expiring-handoff",
      worktreeId: expiringWorktree.id,
    };
    await putSession(ctx, {
      ...base,
      id: "expired",
      status: "running",
      worktreeId: expiringWorktree.id,
      hostId: "reserved-host",
      attemptId: "attempt",
    });
    await putWorktree(ctx, expiringWorktree);
    await expect(
      storage.finishSession({
        sessionId: "expired",
        worktreeId: expiringWorktree.id,
        attemptId: "attempt",
        status: "failed",
        queueShard: 0,
        terminalHookHandoff: expiringHandoff,
      }),
    ).resolves.toBe(true);
    await expect(getWorktree(ctx, expiringWorktree.id)).resolves.toMatchObject({
      status: "busy",
      currentSessionId: "expired",
    });
    await expect(
      storage.expireTerminalHookHandoff({
        sessionId: "expired",
        handoffId: expiringHandoff.handoffId,
        expiresAt: expiringHandoff.expiresAt,
        worktreeId: expiringWorktree.id,
      }),
    ).resolves.toBe(true);
    await expect(getWorktree(ctx, expiringWorktree.id)).resolves.toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });
});
