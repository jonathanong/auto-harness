import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import {
  reconcileSessionDrainDurable,
  reconcileSessionDrainsDurable,
  releaseSessionDrainDurable,
} from "./control-plane-session-drains.ts";
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

function queuedSession(): SessionRecord {
  return {
    id: "session",
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

describe("session drain coverage edges", () => {
  it("does not fail reconciliation when a cancellation audit append fails", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = queuedSession();
    const competing = drain({ status: "failed", failureCode: "DEADLINE_EXCEEDED" });
    state.sessions.set(session.id, session);
    setDurableReadStorage(state, {
      listSessionsForDrain: async () => [session],
      getSession: async () => session,
      cancelQueuedSession: async () => false,
      putAuditLog: async () => {
        throw new Error("audit unavailable");
      },
      updateSessionDrain: async () => false,
      getSessionDrainOperation: async () => competing,
    });

    await expect(reconcileSessionDrainDurable(state, drain())).resolves.toBe(competing);
  });

  it("uses the legacy current-row scan when candidate listing is unavailable", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const current = drain();
    let updated: SessionDrainRecord | undefined;
    setDurableReadStorage(state, {
      listSessionDrains: async () => [current],
      listSessionsForDrain: async () => [],
      updateSessionDrain: async (next: SessionDrainRecord) => {
        updated = next;
        return true;
      },
      getSessionDrainOperation: async () => updated ?? current,
    });

    await expect(reconcileSessionDrainsDurable(state)).resolves.toMatchObject([
      { status: "succeeded", operationId: "operation" },
    ]);
  });

  it("does not release a missing or non-terminal operation", async () => {
    const state = createControlPlaneState();
    setDurableReadStorage(state, { getSessionDrainOperation: async () => null });

    await expect(
      releaseSessionDrainDurable(state, "repo", "principal", "missing"),
    ).resolves.toBeNull();
  });
});
