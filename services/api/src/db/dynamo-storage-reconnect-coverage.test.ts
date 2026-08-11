import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { confirmReconnect, markReconnectPending } from "./plane-storage-reconnect.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import { getSession, getWorktree, putSession, putWorktree } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord, WorktreeRecord } from "./types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;
const now = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhReconnect${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local reconnect transactions", () => {
  it("fences duplicate disconnects and only confirms the deadline it observed", async () => {
    const opts = {
      sessionId: "reconnect-marked",
      hostId: "reconnect-host",
      worktreeId: "reconnect-worktree",
      connectionId: "reconnect-connection",
      deadlineAt: "2026-01-01T00:01:00.000Z",
    };
    const session: SessionRecord = {
      id: opts.sessionId,
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
      status: "running",
      queueShard: 0,
      createdAt: now,
      hostId: opts.hostId,
      worktreeId: opts.worktreeId,
      ackReceivedAt: now,
      assignmentConnectionId: opts.connectionId,
    };
    const worktree: WorktreeRecord = {
      id: opts.worktreeId,
      name: "worktree",
      hostId: opts.hostId,
      repositoryId: "repository",
      path: "/worktree",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: opts.sessionId,
      connectionId: opts.connectionId,
    };
    expect(await tryAcquireHostLock(ctx, { ...opts, replaceExisting: false })).toBe(true);
    await putSession(ctx, session);
    await putWorktree(ctx, worktree);

    expect(await markReconnectPending(ctx, opts)).toBe(true);
    expect(await markReconnectPending(ctx, opts)).toBe(false);
    expect((await getSession(ctx, opts.sessionId))?.reconnectDeadlineAt).toBe(opts.deadlineAt);
    expect((await getWorktree(ctx, opts.worktreeId))?.online).toBe(false);
    expect(await confirmReconnect(ctx, opts)).toBe(true);
    expect((await getSession(ctx, opts.sessionId))?.reconnectDeadlineAt).toBeUndefined();
    expect((await getWorktree(ctx, opts.worktreeId))?.online).toBe(true);
    expect(await confirmReconnect(ctx, opts)).toBe(false);

    const noDeadline = {
      ...opts,
      sessionId: "reconnect-no-deadline",
      worktreeId: "reconnect-no-deadline-wt",
    };
    await putSession(ctx, {
      ...session,
      id: noDeadline.sessionId,
      worktreeId: noDeadline.worktreeId,
    });
    await putWorktree(ctx, {
      ...worktree,
      id: noDeadline.worktreeId,
      currentSessionId: noDeadline.sessionId,
    });
    expect(await confirmReconnect(ctx, { ...noDeadline, deadlineAt: undefined })).toBe(true);
  });

  it("rethrows a real Dynamo resource error instead of treating it as a race loss", async () => {
    await expect(
      markReconnectPending(
        { ...ctx, tables: { ...tables, hostLocks: "not-a-table" } },
        { sessionId: "missing", hostId: "missing", worktreeId: "missing", connectionId: "missing" },
      ),
    ).rejects.toThrow();
    await expect(
      confirmReconnect(
        { ...ctx, tables: { ...tables, hostLocks: "not-a-table" } },
        { sessionId: "missing", hostId: "missing", worktreeId: "missing", connectionId: "missing" },
      ),
    ).rejects.toThrow();
  });
});
