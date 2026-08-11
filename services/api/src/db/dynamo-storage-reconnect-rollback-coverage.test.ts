import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { restoreReconnectPending } from "./plane-storage-reconnect-rollback.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import { getSession, getWorktree, putSession, putWorktree } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;
const now = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhRollback${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local reconnect rollback transactions", () => {
  it("restores populated and absent reconnect fields without extending grace", async () => {
    const populated = {
      sessionId: "rollback-populated",
      hostId: "rollback-host",
      worktreeId: "rollback-worktree",
      connectionId: "rollback-current",
      previousDeadlineAt: "2026-01-01T00:02:00.000Z",
      previousAssignmentConnectionId: "rollback-previous",
      previousWorktreeConnectionId: "rollback-worktree-previous",
    };
    const running = {
      repositoryId: "repository",
      prompt: "prompt",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: now,
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "running" as const,
      queueShard: 0,
      createdAt: now,
      hostId: populated.hostId,
    };
    expect(await tryAcquireHostLock(ctx, { ...populated, replaceExisting: false })).toBe(true);
    await putSession(ctx, {
      ...running,
      id: populated.sessionId,
      worktreeId: populated.worktreeId,
      assignmentConnectionId: populated.connectionId,
    });
    await putWorktree(ctx, {
      id: populated.worktreeId,
      name: "worktree",
      hostId: populated.hostId,
      repositoryId: "repository",
      path: "/worktree",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: populated.sessionId,
      connectionId: populated.connectionId,
    });
    expect(await restoreReconnectPending(ctx, populated)).toBe(true);
    expect(await getSession(ctx, populated.sessionId)).toMatchObject({
      reconnectDeadlineAt: populated.previousDeadlineAt,
      assignmentConnectionId: populated.previousAssignmentConnectionId,
    });
    expect((await getWorktree(ctx, populated.worktreeId))?.connectionId).toBe(
      populated.previousWorktreeConnectionId,
    );
    expect(await restoreReconnectPending(ctx, populated)).toBe(false);

    const legacy = {
      ...populated,
      sessionId: "rollback-legacy",
      worktreeId: "rollback-legacy-worktree",
    };
    await putSession(ctx, {
      ...running,
      id: legacy.sessionId,
      worktreeId: legacy.worktreeId,
      assignmentConnectionId: legacy.connectionId,
    });
    await putWorktree(ctx, {
      id: legacy.worktreeId,
      name: "legacy",
      hostId: legacy.hostId,
      repositoryId: "repository",
      path: "/legacy",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: legacy.sessionId,
      connectionId: legacy.connectionId,
    });
    expect(
      await restoreReconnectPending(ctx, {
        sessionId: legacy.sessionId,
        hostId: legacy.hostId,
        worktreeId: legacy.worktreeId,
        connectionId: legacy.connectionId,
      }),
    ).toBe(true);
    const restored = await getSession(ctx, legacy.sessionId);
    expect(restored?.assignmentConnectionId).toBeUndefined();
    expect(restored?.reconnectDeadlineAt).toBeUndefined();
    expect((await getWorktree(ctx, legacy.worktreeId))?.connectionId).toBeUndefined();
  });

  it("rethrows a real Dynamo resource error rather than reporting a lost race", async () => {
    await expect(
      restoreReconnectPending(
        { ...ctx, tables: { ...tables, hostLocks: "not-a-table" } },
        { sessionId: "missing", hostId: "missing", worktreeId: "missing", connectionId: "missing" },
      ),
    ).rejects.toThrow();
  });
});
