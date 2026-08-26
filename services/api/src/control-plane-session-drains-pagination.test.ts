import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { reconcileSessionDrainDurable } from "./control-plane-session-drains.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionDrainRecord } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function drain(over: Partial<SessionDrainRecord> = {}): SessionDrainRecord {
  return {
    scopeKey: "repo#principal",
    recordKey: "CURRENT",
    operationId: "operation",
    repositoryId: "repo",
    principalId: "principal",
    status: "draining",
    requestedAt: NOW,
    updatedAt: NOW,
    deadlineAt: "2026-01-01T00:15:00.000Z",
    queuedCount: 0,
    runningCount: 0,
    cancelledCount: 0,
    ...over,
  };
}

function queuedSession(index: number): SessionRecord {
  return {
    id: `session-${index.toString().padStart(3, "0")}`,
    repositoryId: "repo",
    principalId: "principal",
    prompt: "queued",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T00:01:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    metadata: { createdBy: "principal" },
  };
}

function runningSession(index: number): SessionRecord {
  return {
    ...queuedSession(index),
    status: "running",
    worktreeId: `worktree-${index}`,
    hostId: "host",
    assignmentConnectionId: "connection",
    attemptId: "attempt",
  };
}

describe("session drain reconciliation pagination", () => {
  it("does not replace a strong terminal row with a stale process cache entry", async () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:16:00.000Z" });
    const stale = queuedSession(1);
    const terminal: SessionRecord = {
      ...stale,
      status: "cancelled",
      cancelledByDrainOperationId: "operation",
    };
    state.sessions.set(stale.id, stale);
    let durableDrain = drain();
    setDurableReadStorage(state, {
      listSessionsForDrain: async () => ({ sessions: [terminal] }),
      updateSessionDrain: async (updated: SessionDrainRecord) => {
        durableDrain = { ...updated };
        return true;
      },
      getSessionDrainOperation: async () => durableDrain,
    });

    await expect(reconcileSessionDrainDurable(state, durableDrain)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("reconciles more than one hundred queued sessions in bounded resumable pages", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const activities = Array.from({ length: 101 }, (_, index) => queuedSession(index));
    let durableDrain = drain();
    let pageReads = 0;
    setDurableReadStorage(state, {
      listSessionsForDrain: async (
        _repo,
        _principal,
        _operation,
        _shards,
        cursor?: { id?: string },
      ) => {
        pageReads += 1;
        const start = cursor?.id ? activities.findIndex((session) => session.id > cursor.id!) : 0;
        if (start < 0) return { sessions: [] };
        const sessions = activities.slice(start, start + 25);
        return {
          sessions: sessions.map((session) => ({ ...session })),
          ...(start + sessions.length < activities.length
            ? { nextKey: { id: sessions.at(-1)!.id } }
            : {}),
        };
      },
      cancelQueuedSession: async (options: { sessionId: string; drainOperationId?: string }) => {
        const index = activities.findIndex((session) => session.id === options.sessionId);
        if (index < 0) return false;
        const [session] = activities.splice(index, 1);
        state.sessions.set(options.sessionId, {
          ...session!,
          status: "cancelled",
          cancelledByDrainOperationId: options.drainOperationId,
        });
        return true;
      },
      updateSessionDrain: async (updated: SessionDrainRecord) => {
        durableDrain = { ...updated };
        return true;
      },
      getSessionDrainOperation: async () => durableDrain,
      putAuditLog: async () => {},
    });

    for (let invocation = 0; invocation < 10 && durableDrain.status === "draining"; invocation++) {
      durableDrain = await reconcileSessionDrainDurable(state, durableDrain);
    }

    expect(durableDrain).toMatchObject({ status: "succeeded", cancelledCount: 101 });
    expect(activities).toEqual([]);
    expect(pageReads).toBeGreaterThan(4);
  });

  it("keeps aggregate live counts when a deadline expires on a later page", async () => {
    let now = NOW;
    const state = createControlPlaneState({ now: () => now });
    const first = runningSession(1);
    const second = queuedSession(2);
    let durableDrain = drain({ deadlineAt: "2026-01-01T00:00:01.000Z" });
    const terminalAudits: unknown[] = [];
    setDurableReadStorage(state, {
      listSessionsForDrain: async (
        _repo,
        _principal,
        _operation,
        _shards,
        cursor?: { page?: number },
      ) =>
        cursor?.page === 2 ? { sessions: [second] } : { sessions: [first], nextKey: { page: 2 } },
      cancelQueuedSession: async () => false,
      cancelRunningSession: async () => false,
      updateSessionDrain: async (updated: SessionDrainRecord, audit: unknown) => {
        durableDrain = { ...updated };
        if (audit) terminalAudits.push(audit);
        return true;
      },
    });

    durableDrain = await reconcileSessionDrainDurable(state, durableDrain);
    expect(durableDrain).toMatchObject({
      status: "draining",
      activityCursor: { page: 2 },
      queuedCount: 0,
      runningCount: 1,
    });

    now = "2026-01-01T00:00:01.000Z";
    durableDrain = await reconcileSessionDrainDurable(state, durableDrain);
    expect(durableDrain).toMatchObject({
      status: "failed",
      queuedCount: 1,
      runningCount: 1,
      failureCode: "DEADLINE_EXCEEDED",
    });
    expect(terminalAudits).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ queuedCount: 1, runningCount: 1 }),
      }),
    ]);
  });
});
