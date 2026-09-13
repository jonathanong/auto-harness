import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { reclaimScheduledReconnect } from "./control-plane-reconnect-scheduled.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function cancelledSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "cancelled",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "cancelled",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    hostId: "host",
    worktreeId: null,
    attemptId: "attempt",
    assignmentConnectionId: "connection",
    mainCheckoutLease: true,
    assignmentSentAt: NOW,
    ackReceivedAt: NOW,
    reconnectDeadlineAt: NOW,
    activeHostId: "host",
    activeHostOrder: ["host"],
    concurrencyId: "schedule-cancelled",
    ...over,
  };
}

describe("scheduled reconnect cancelled cleanup", () => {
  it("clears assignment fields after a durable cancelled release", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = cancelledSession();
    state.sessions.set(session.id, session);
    state.pendingAcks.set(session.id, { attemptId: "attempt", sentAt: NOW });
    const releaseCalls: Record<string, unknown>[] = [];
    state.storage = {
      releaseMainCheckoutSession: async (options: Record<string, unknown>) => {
        releaseCalls.push(options);
        return true;
      },
    } as never;

    const requeued: string[] = [];
    await expect(reclaimScheduledReconnect(state, session, requeued)).resolves.toBe(true);

    expect(requeued).toEqual([]);
    expect(releaseCalls[0]).toMatchObject({
      status: "cancelled",
      expectedStatus: "cancelled",
      concurrencyId: "schedule-cancelled",
      reason: "cancelled by operator",
    });
    expect(state.sessions.get(session.id)).not.toMatchObject({
      mainCheckoutLease: expect.anything(),
      assignmentConnectionId: expect.anything(),
      assignmentSentAt: expect.anything(),
      ackReceivedAt: expect.anything(),
      reconnectDeadlineAt: expect.anything(),
      activeHostId: expect.anything(),
      activeHostOrder: expect.anything(),
    });
    expect(state.pendingAcks.has(session.id)).toBe(false);
  });

  it("uses an explicit cancellation reason when one is present", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = cancelledSession({ errorMessage: "cancelled by test" });
    state.storage = {
      releaseMainCheckoutSession: async (options: Record<string, unknown>) => {
        expect(options.reason).toBe("cancelled by test");
        return false;
      },
    } as never;

    await expect(reclaimScheduledReconnect(state, session, [])).resolves.toBe(true);
  });
});
