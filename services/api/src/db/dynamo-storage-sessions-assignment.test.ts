/* eslint-disable max-lines -- assignment transaction fences share one DynamoDB fixture. */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import { tryAssignMainCheckoutSession } from "./plane-storage-main-checkout.ts";
import {
  deleteWorktree,
  getWorktree,
  listAllWorktrees,
  listWorktreesForRepo,
  putSession,
  putWorktree,
  putWorktreeFenced,
  tryAssignSession,
  tryClaimWorktree,
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
  createdAt: "2026-01-01T00:00:00.000Z",
};
const worktree = {
  name: "worktree",
  hostId: "host",
  repositoryId: "repo",
  path: "/repo",
  labels: [],
  status: "idle" as const,
  online: true,
};

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Assign${process.pid}` });
  ctx = { doc: clients.doc, tables };
  await ctx.doc.send(
    new PutCommand({
      TableName: tables.repositories,
      Item: { id: "repo", name: "repo", url: "url", defaultBranch: "main" },
    }),
  );
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local session assignment", () => {
  it("fences inventory writes and preserves a busy worktree", async () => {
    await putWorktree(ctx, { ...worktree, id: "fenced" });
    expect(
      await putWorktreeFenced(
        ctx,
        { ...worktree, id: "fenced", path: "/new" },
        { hostId: "host", connectionId: "missing" },
      ),
    ).toBe(false);
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "host",
        hostInventoryVersion: null,
        connectionId: "one",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await putWorktreeFenced(
        ctx,
        { ...worktree, id: "fenced", path: "/new" },
        { hostId: "host", connectionId: "one" },
      ),
    ).toBe(true);
    expect(
      await tryClaimWorktree(ctx, { worktreeId: "fenced", sessionId: "busy", now: "now" }),
    ).toBe(true);
    expect(
      await putWorktreeFenced(
        ctx,
        { ...worktree, id: "fenced", path: "/stale" },
        { hostId: "host", connectionId: "one" },
      ),
    ).toBe(false);
    expect(
      await tryClaimWorktree(ctx, { worktreeId: "fenced", sessionId: "again", now: "later" }),
    ).toBe(false);
    expect((await listWorktreesForRepo(ctx, "repo")).map((item) => item.id)).toContain("fenced");
    expect((await listAllWorktrees(ctx)).map((item) => item.id)).toContain("fenced");
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        ctx.doc.send(
          new PutCommand({
            TableName: tables.worktrees,
            Item: { ...worktree, id: `page-${index}`, padding: "x".repeat(380_000) },
          }),
        ),
      ),
    );
    expect((await listAllWorktrees(ctx)).filter((item) => item.id.startsWith("page-")).length).toBe(
      4,
    );
    expect(
      (await listWorktreesForRepo(ctx, "repo")).filter((item) => item.id.startsWith("page-"))
        .length,
    ).toBe(4);
    await deleteWorktree(ctx, "fenced");
    expect(await getWorktree(ctx, "fenced")).toBeNull();
    await expect(
      putWorktreeFenced(
        { ...ctx, tables: { ...tables, worktrees: "missing-worktrees" } },
        { ...worktree, id: "unavailable" },
        { hostId: "host", connectionId: "one" },
      ),
    ).rejects.toThrow();
    await expect(
      tryClaimWorktree(
        { ...ctx, tables: { ...tables, worktrees: "missing-worktrees" } },
        { worktreeId: "unavailable", sessionId: "session", now: "now" },
      ),
    ).rejects.toThrow();
  });

  it("atomically assigns only an idle queued session behind the current host lease", async () => {
    await putSession(ctx, { ...session, id: "assignment" });
    await putWorktree(ctx, { ...worktree, id: "assignment-worktree" });
    expect(
      await tryAssignSession(ctx, {
        sessionId: "assignment",
        repositoryId: "repo",
        worktreeId: "assignment-worktree",
        hostId: "host",
        hostInventoryVersion: null,
        connectionId: "one",
        now: "2025-01-01T00:00:00.000Z",
        attemptId: "attempt",
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: "assignment-worktree",
          attemptId: "attempt",
        },
        queueShard: 0,
      }),
    ).toBe(true);
    expect((await getWorktree(ctx, "assignment-worktree"))?.currentSessionId).toBe("assignment");
    expect(
      await tryAssignSession(ctx, {
        sessionId: "assignment",
        repositoryId: "repo",
        worktreeId: "assignment-worktree",
        hostId: "host",
        hostInventoryVersion: null,
        connectionId: "one",
        now: "2025-01-01T00:00:01.000Z",
        attemptId: "again",
        resolvedArgv: ["echo"],
        resumeSpec: { provider: "codex", resumeRef: "opaque" },
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: "assignment-worktree",
          attemptId: "again",
        },
        queueShard: 0,
      }),
    ).toBe(false);
    await putSession(ctx, { ...session, id: "no-lease" });
    await putWorktree(ctx, { ...worktree, id: "no-lease-worktree" });
    expect(
      await tryAssignSession(ctx, {
        sessionId: "no-lease",
        repositoryId: "repo",
        worktreeId: "no-lease-worktree",
        hostId: "host",
        hostInventoryVersion: null,
        connectionId: "stale",
        now: "2025-01-01T00:00:00.000Z",
        attemptId: "attempt",
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: "no-lease-worktree",
          attemptId: "attempt",
        },
        queueShard: 0,
      }),
    ).toBe(false);

    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostInventories,
        Item: { hostId: "host", version: 2, repositories: [], providerAccounts: [] },
      }),
    );
    await putSession(ctx, { ...session, id: "stale-inventory" });
    await putWorktree(ctx, { ...worktree, id: "stale-inventory-worktree" });
    expect(
      await tryAssignSession(ctx, {
        sessionId: "stale-inventory",
        repositoryId: "repo",
        worktreeId: "stale-inventory-worktree",
        hostId: "host",
        hostInventoryVersion: 1,
        connectionId: "one",
        now: "2025-01-01T00:00:02.000Z",
        attemptId: "stale-inventory-attempt",
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: "stale-inventory-worktree",
          attemptId: "stale-inventory-attempt",
        },
        queueShard: 0,
      }),
    ).toBe(false);
    expect((await getWorktree(ctx, "stale-inventory-worktree"))?.status).toBe("idle");
  });

  it("rejects a scheduled main-checkout claim after queue expiry", async () => {
    const hostId = "scheduled-host";
    const connectionId = "scheduled-connection";
    const now = "2025-01-01T00:00:00.000Z";
    const claim = {
      hostId,
      hostInventoryVersion: null,
      repositoryId: "repo",
      connectionId,
      now,
      resolvedArgv: ["echo"],
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        hostId,
        worktreeId: null,
        attemptId: "attempt",
      },
      queueShard: 0,
      attemptId: "attempt",
    };
    expect(await tryAcquireHostLock(ctx, { hostId, connectionId, replaceExisting: false })).toBe(
      true,
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.connections,
        Item: {
          connectionId,
          hostId,
          capabilities: ["scheduled-main-checkout"],
          repositoryIds: ["repo"],
        },
      }),
    );
    await putSession(ctx, {
      ...session,
      id: "expired-scheduled",
      type: "scheduled",
      queueExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      await tryAssignMainCheckoutSession(ctx, { ...claim, sessionId: "expired-scheduled" }),
    ).toBe(false);
    await putSession(ctx, {
      ...session,
      id: "live-scheduled",
      type: "scheduled",
      queueExpiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(await tryAssignMainCheckoutSession(ctx, { ...claim, sessionId: "live-scheduled" })).toBe(
      true,
    );
  });

  it("refuses a provider lease slot at or above the durable account cap", async () => {
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.providerAccounts,
        Item: {
          id: "capped",
          providerId: "provider",
          name: "capped",
          maxConcurrentSessions: 1,
          createdAt: "now",
          updatedAt: "now",
        },
      }),
    );
    await putSession(ctx, { ...session, id: "capped-session" });
    await putWorktree(ctx, { ...worktree, id: "capped-worktree", hostId: "capped-host" });
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "capped-host",
        hostInventoryVersion: null,
        connectionId: "one",
        replaceExisting: false,
      }),
    ).toBe(true);
    const assign = (slot: number) =>
      tryAssignSession(ctx, {
        sessionId: "capped-session",
        repositoryId: "repo",
        worktreeId: "capped-worktree",
        hostId: "capped-host",
        hostInventoryVersion: null,
        connectionId: "one",
        now: "2025-01-01T00:00:00.000Z",
        attemptId: `attempt-${String(slot)}`,
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "capped-host",
          worktreeId: "capped-worktree",
          attemptId: `attempt-${String(slot)}`,
        },
        providerAccountId: "capped",
        providerAccountLease: {
          concurrencyId: `acct:capped:${String(slot)}`,
          providerAccountId: "capped",
          slot,
          attemptId: `attempt-${String(slot)}`,
        },
        queueShard: 0,
      });
    expect(await assign(1)).toBe(false);
    expect((await getWorktree(ctx, "capped-worktree"))?.status).toBe("idle");
    expect(await assign(0)).toBe(true);
  });
});
