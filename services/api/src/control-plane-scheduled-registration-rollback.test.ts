import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

const ctx = createDynamoTestCtx("SchedRegRollback");
const NOW = "2026-01-01T00:00:00.000Z";

describe("scheduled registration rollback", () => {
  it("keeps a confirmed run reclaimable when final inventory publication fails", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const hostId = "host-rollback";
    const repositoryId = "repo-rollback";
    const sessionId = "session-rollback";
    const oldConnectionId = "connection-rollback-old";
    expect(
      await ctx.storage.tryRegisterHost({
        hostId,
        replaceExisting: true,
        connection: {
          connectionId: oldConnectionId,
          type: "host",
          hostId,
          connectedAt: NOW,
          lastHeartbeatAt: NOW,
          commandProfiles: [],
          capabilities: ["scheduled-main-checkout"],
          repositoryIds: [repositoryId],
        },
      }),
    ).toBe(true);
    const session: SessionRecord = {
      id: sessionId,
      repositoryId,
      prompt: "rollback",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      queueTtlSeconds: 3600,
      queueExpiresAt: "2026-01-01T01:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: NOW,
      retryCount: 0,
      type: "scheduled",
      source: "schedule",
    };
    await ctx.storage.putSession(session);
    const attemptId = "attempt-rollback-old";
    expect(
      await ctx.storage.tryAssignMainCheckoutSession({
        sessionId,
        hostId,
        repositoryId,
        connectionId: oldConnectionId,
        now: NOW,
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId,
          worktreeId: null,
          attemptId,
        },
        attemptId,
        queueShard: 0,
      }),
    ).toBe(true);
    expect(
      await ctx.storage.acknowledgeSession(sessionId, NOW, {
        hostId,
        connectionId: oldConnectionId,
      }),
    ).toBe(true);

    const replacement = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
      reconnectGraceMs: 100,
      now: () => NOW,
      connectionIdFactory: () => "connection-rollback-new",
    });
    await replacement.plane.hydrateFromStorage();
    const replacementStorage = replacement.plane.state.storage!;
    const originalPut = replacementStorage.putHostInventoryFenced.bind(replacementStorage);
    replacementStorage.putHostInventoryFenced = async () => {
      throw new Error("inventory failed");
    };
    try {
      await expect(
        replacement.plane.registerHostDurable({
          hostId,
          worktrees: [],
          commandProfiles: [],
          capabilities: ["scheduled-main-checkout"],
          repositories: [{ id: repositoryId, path: "/repo-rollback", defaultBranch: "main" }],
          runningSessions: [sessionId],
          replaceExisting: true,
        }),
      ).rejects.toThrow("inventory failed");
    } finally {
      replacementStorage.putHostInventoryFenced = originalPut;
    }

    expect(await ctx.storage.getSession(sessionId)).toMatchObject({
      status: "running",
      assignmentConnectionId: "connection-rollback-new",
      reconnectDeadlineAt: "2026-01-01T00:00:00.100Z",
    });
    expect(await ctx.storage.getMainCheckoutLease(hostId, repositoryId)).toEqual({
      sessionId,
      connectionId: "connection-rollback-new",
    });
    expect(await ctx.storage.getHostLock(hostId)).toBeNull();

    const reclaimer = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
    });
    await reclaimer.plane.hydrateFromStorage();
    expect(await reclaimer.plane.reclaimReconnectDeadlines(Date.parse(NOW) + 100)).toEqual([
      sessionId,
    ]);
    expect(await ctx.storage.getMainCheckoutLease(hostId, repositoryId)).toBeNull();
    expect(await ctx.storage.getSession(sessionId)).toMatchObject({ status: "queued" });
  });
});
