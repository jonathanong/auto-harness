import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
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
        worktreeId: "assignment-worktree",
        hostId: "host",
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
        worktreeId: "assignment-worktree",
        hostId: "host",
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
        worktreeId: "no-lease-worktree",
        hostId: "host",
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
  });
});
