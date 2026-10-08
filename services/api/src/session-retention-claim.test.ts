import { describe, expect, it } from "vitest";

import {
  claimSessionRetention,
  leaseSessionRetentionJob,
} from "./db/plane-storage-session-retention-claim.ts";
import type { RetentionJob } from "./db/plane-storage-session-retention-types.ts";
import type { PlaneStorageCtx } from "./db/plane-storage-types.ts";
import type { SessionRecord } from "./db/types.ts";

const now = "2026-01-01T00:00:00.000Z";

function testContext(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return {
    doc: { send },
    tables: { sessions: "Sessions", sessionDrains: "SessionDrains", archives: "Archives" },
  } as unknown as PlaneStorageCtx;
}

function terminalSession(): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: now,
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: "2025-11-30T23:00:00.000Z",
    completedAt: "2025-12-01T00:00:00.000Z",
  };
}

function retentionJob(): RetentionJob {
  return {
    scopeKey: "__retention#v1#jobs",
    recordKey: "2026-01-01T00:02:00.000Z#token",
    sessionId: "session",
    repositoryId: "repo",
    queueShard: 0,
    activityGeneration: "2025-11-30T23:00:00.000Z",
    createdAt: "2025-11-30T23:00:00.000Z",
    completedAt: "2025-12-01T00:00:00.000Z",
    token: "token",
    readyAt: "2026-01-01T00:02:00.000Z",
    retentionDays: 30,
  };
}

describe("session retention claim persistence errors", () => {
  it("propagates unexpected retention claim transaction errors", async () => {
    const failure = new Error("transaction unavailable");
    const ctx = testContext(async () => {
      throw failure;
    });

    await expect(claimSessionRetention(ctx, terminalSession(), now)).rejects.toBe(failure);
  });

  it("leases a job and propagates unexpected lease errors", async () => {
    const working = testContext(async () => ({}));
    await expect(leaseSessionRetentionJob(working, retentionJob(), now, "worker")).resolves.toBe(
      true,
    );

    const failure = new Error("lease unavailable");
    const broken = testContext(async () => {
      throw failure;
    });
    await expect(leaseSessionRetentionJob(broken, retentionJob(), now, "worker")).rejects.toBe(
      failure,
    );
  });
});
