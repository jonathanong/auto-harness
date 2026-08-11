import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import {
  getWorktree,
  putSession,
  putWorktree,
  releaseWorktree,
  setWorktreeOnline,
  setWorktreeOnlineFenced,
  tryAssignSession,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;
const session = {
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
  status: "queued" as const,
  queueShard: 0,
  createdAt: "now",
};
beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Options${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local optional session transitions", () => {
  it("records the account assignment and enforces a fenced worktree connection", async () => {
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
    await putSession(ctx, { ...session, id: "session" });
    await putWorktree(ctx, {
      id: "worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "idle",
      online: true,
      connectionId: "connection",
    });
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await tryAssignSession(ctx, {
        sessionId: "session",
        worktreeId: "worktree",
        hostId: "host",
        connectionId: "connection",
        now: "2025-01-01T00:00:00.000Z",
        attemptId: "attempt",
        resolvedArgv: ["echo"],
        resumeSpec: { provider: "codex", resumeRef: "opaque" },
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: "worktree",
          attemptId: "attempt",
        },
        providerAccountId: "account",
        queueShard: 0,
      }),
    ).toBe(true);
    await releaseWorktree(ctx, "worktree", { forceOffline: true });
    await setWorktreeOnline(ctx, "worktree", true);
    expect(await setWorktreeOnlineFenced(ctx, "worktree", "wrong", false)).toBe(false);
    expect(await setWorktreeOnlineFenced(ctx, "worktree", "connection", false)).toBe(true);
    expect(
      await setWorktreeOnlineFenced(ctx, "worktree", "connection", false, {
        hostId: "host",
        connectionId: "connection",
      }),
    ).toBe(true);
    await releaseWorktree(ctx, "worktree");
    expect((await getWorktree(ctx, "worktree"))?.online).toBe(false);
    await setWorktreeOnline(ctx, "worktree", true);
    await releaseWorktree(ctx, "worktree", { forceOffline: false });
    expect((await getWorktree(ctx, "worktree"))?.online).toBe(true);
    await releaseWorktree(ctx, "missing");
  });
});
