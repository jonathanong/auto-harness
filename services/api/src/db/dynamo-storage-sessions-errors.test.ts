import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  cancelQueuedSession,
  acknowledgeSession,
  clearResumePin,
  expireQueuedSession,
  failExpiredResumeSession,
  finishSession,
  putWorktreeFenced,
  requeueUsageLimitedSession,
  setWorktreeOnlineFenced,
  suppressProviderlessUsageLimit,
  tryAssignSession,
  tryClaimWorktree,
  tryRequeueSession,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;
beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Errors${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local session storage failures", () => {
  it("propagates real missing-table failures instead of reporting claim loss", async () => {
    const missing = {
      ...ctx,
      tables: { ...tables, sessions: "missing-sessions", worktrees: "missing-worktrees" },
    };
    await expect(
      putWorktreeFenced(
        missing,
        {
          id: "worktree",
          name: "worktree",
          hostId: "host",
          repositoryId: "repo",
          path: "/repo",
          labels: [],
          status: "idle",
          online: true,
        },
        { hostId: "host", connectionId: "connection" },
      ),
    ).rejects.toThrow();
    await expect(
      tryClaimWorktree(missing, { worktreeId: "worktree", sessionId: "session", now: "now" }),
    ).rejects.toThrow();
    await expect(acknowledgeSession(missing, "session", "now")).rejects.toThrow();
    await expect(
      tryAssignSession(missing, {
        sessionId: "session",
        worktreeId: "worktree",
        hostId: "host",
        hostInventoryVersion: null,
        connectionId: "connection",
        now: "now",
        attemptId: "attempt",
        resolvedArgv: [],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: "worktree",
          attemptId: "attempt",
        },
        queueShard: 0,
      }),
    ).rejects.toThrow();
    await expect(
      failExpiredResumeSession(missing, {
        sessionId: "session",
        queueShard: 0,
        pinExpiresAt: "pin",
      }),
    ).rejects.toThrow();
    await expect(
      cancelQueuedSession(missing, {
        sessionId: "session",
        queueShard: 0,
        completedAt: "done",
        errorMessage: "cancel",
      }),
    ).rejects.toThrow();
    await expect(
      clearResumePin(missing, { sessionId: "session", pinnedHostId: "host" }),
    ).rejects.toThrow();
    await expect(
      tryRequeueSession(missing, {
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
        queueShard: 0,
      }),
    ).rejects.toThrow();
    await expect(
      finishSession(missing, {
        sessionId: "session",
        attemptId: "attempt",
        status: "completed",
        queueShard: 0,
      }),
    ).rejects.toThrow();
    await expect(
      expireQueuedSession(missing, {
        sessionId: "session",
        queueShard: 0,
        queueExpiresAt: "expiry",
        completedAt: "done",
      }),
    ).rejects.toThrow();
    await expect(
      suppressProviderlessUsageLimit(missing, {
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
        queueShard: 0,
        targetIndex: 0,
      }),
    ).rejects.toThrow();
    await expect(
      requeueUsageLimitedSession(missing, {
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
        providerAccountId: "account",
        queueShard: 0,
        now: "now",
        usageLimitedUntil: "later",
      }),
    ).rejects.toThrow();
    await expect(
      setWorktreeOnlineFenced(missing, "worktree", "connection", true),
    ).rejects.toThrow();
  });
});
