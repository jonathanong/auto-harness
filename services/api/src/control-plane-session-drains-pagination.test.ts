import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { reconcileSessionDrainDurable } from "./control-plane-session-drains.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionDrainRecord } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function drain(): SessionDrainRecord {
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
    targetLabels: ["command"],
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

describe("session drain reconciliation pagination", () => {
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
});
