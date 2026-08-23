import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import {
  createSessionDrainDurable,
  getSessionDrainDurable,
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

function queuedLegacy(): SessionRecord {
  return {
    id: "legacy",
    repositoryId: "repo",
    prompt: "legacy",
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

describe("session drain residual outcomes", () => {
  it("requires durable storage for every operation", async () => {
    const state = createControlPlaneState();
    const row = drain({ status: "succeeded" });
    await expect(reconcileSessionDrainDurable(state, row)).resolves.toBe(row);
    await expect(reconcileSessionDrainsDurable(state)).resolves.toEqual([]);
    await expect(createSessionDrainDurable(state, "repo", "principal")).resolves.toEqual({
      error: "durable storage is required",
      code: "DURABLE_REQUIRED",
    });
    await expect(
      getSessionDrainDurable(state, "repo", "principal", "operation"),
    ).resolves.toBeNull();
    await expect(
      releaseSessionDrainDurable(state, "repo", "principal", "operation"),
    ).resolves.toBeNull();
  });

  it("audits a lost cancellation and returns the competing operation update", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = queuedLegacy();
    const competing = drain({ status: "failed", failureCode: "DEADLINE_EXCEEDED" });
    state.sessions.set(session.id, session);
    const audits: Array<{ outcome?: string }> = [];
    setDurableReadStorage(state, {
      listAllSessions: async () => [session],
      getSession: async () => session,
      cancelQueuedSession: async () => false,
      putAuditLog: async (record: { outcome?: string }) => audits.push(record),
      updateSessionDrain: async () => false,
      getSessionDrainOperation: async () => competing,
    });

    await expect(reconcileSessionDrainDurable(state, drain())).resolves.toBe(competing);
    expect(audits).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("falls back to the computed update after a lost CAS and handles missing repositories", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    setDurableReadStorage(state, {
      listAllSessions: async () => [],
      updateSessionDrain: async () => false,
      getSessionDrainOperation: async () => null,
      getRepository: async () => null,
    });
    await expect(reconcileSessionDrainDurable(state, drain())).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(createSessionDrainDurable(state, "missing", "principal")).resolves.toEqual({
      error: "repository not found",
      code: "NOT_FOUND",
    });
    await expect(getSessionDrainDurable(state, "repo", "principal", "missing")).resolves.toBeNull();
  });

  it("recomputes cancellation counts from durable attribution after a lost update", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = queuedLegacy();
    let durableDrain = drain();
    let updateCalls = 0;
    state.sessions.set(session.id, session);
    setDurableReadStorage(state, {
      getSession: async () => ({ ...session }),
      listAllSessions: async () => [{ ...session }],
      cancelQueuedSession: async (options: { drainOperationId?: string }) => {
        if (session.status !== "queued") return false;
        session.status = "cancelled";
        session.cancelledByDrainOperationId = options.drainOperationId;
        return true;
      },
      updateSessionDrain: async (updated: SessionDrainRecord) => {
        updateCalls += 1;
        if (updateCalls === 1) return false;
        durableDrain = { ...updated };
        return true;
      },
      getSessionDrainOperation: async () => durableDrain,
    });

    const first = await reconcileSessionDrainDurable(state, drain());
    expect(first).toMatchObject({ status: "draining", cancelledCount: 0 });

    const recovered = await reconcileSessionDrainDurable(state, first);
    expect(recovered).toMatchObject({
      status: "succeeded",
      cancelledCount: 1,
    });
    expect(session.cancelledByDrainOperationId).toBe("operation");
  });
});
