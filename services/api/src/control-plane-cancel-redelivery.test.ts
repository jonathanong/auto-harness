import { describe, expect, it } from "vitest";

import {
  MAX_CANCEL_REDELIVERY_ATTEMPTS,
  redeliverPendingCancels,
} from "./control-plane-cancel-redelivery.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import type { CancelRedeliveryRecord } from "./db/plane-storage-cancel-redeliveries.ts";

function candidate(overrides: Partial<CancelRedeliveryRecord> = {}): CancelRedeliveryRecord {
  return {
    sessionId: "session-1",
    hostId: "host-1",
    attemptId: "attempt-1",
    status: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("redeliverPendingCancels", () => {
  it("returns 0 without durable storage", async () => {
    const state = createControlPlaneState();
    await expect(redeliverPendingCancels(state)).resolves.toBe(0);
  });

  it("redelivers to a connected host once the attempt claim succeeds", async () => {
    const fixedNow = "2026-01-01T00:00:00.000Z";
    const state = createControlPlaneState({ now: () => fixedNow });
    const claims: Array<{ sessionId: string; now: string; maxAttempts: number }> = [];
    setDurableReadStorage(state, {
      listPendingCancelRedeliveries: async () => [candidate()],
      getHostLock: async () => "connection-1",
      claimCancelRedeliveryAttempt: async (sessionId: string, now: string, maxAttempts: number) => {
        claims.push({ sessionId, now, maxAttempts });
        return true;
      },
      clearPendingCancelRedelivery: async () => undefined,
    });
    const pushed: Array<{ hostId: string; message: unknown }> = [];
    state.onHostMessage = (hostId, message) => void pushed.push({ hostId, message });

    await expect(redeliverPendingCancels(state)).resolves.toBe(1);

    expect(pushed).toEqual([
      {
        hostId: "host-1",
        message: { type: "session:cancel", sessionId: "session-1", attemptId: "attempt-1" },
      },
    ]);
    expect(claims).toEqual([
      { sessionId: "session-1", now: fixedNow, maxAttempts: MAX_CANCEL_REDELIVERY_ATTEMPTS },
    ]);
  });

  it("leaves the marker pending, without claiming or clearing, while the host is disconnected", async () => {
    const state = createControlPlaneState();
    const cleared: string[] = [];
    let claimCalled = false;
    setDurableReadStorage(state, {
      listPendingCancelRedeliveries: async () => [candidate()],
      getHostLock: async () => null,
      claimCancelRedeliveryAttempt: async () => {
        claimCalled = true;
        return true;
      },
      clearPendingCancelRedelivery: async (sessionId: string) => void cleared.push(sessionId),
    });
    let pushCount = 0;
    state.onHostMessage = () => void (pushCount += 1);

    await expect(redeliverPendingCancels(state)).resolves.toBe(0);

    expect(cleared).toEqual([]);
    expect(pushCount).toBe(0);
    expect(claimCalled).toBe(false);
  });

  it("skips dispatch and clears the marker when the attempt claim fails", async () => {
    const state = createControlPlaneState();
    const cleared: string[] = [];
    setDurableReadStorage(state, {
      listPendingCancelRedeliveries: async () => [candidate({ attempts: 2 })],
      getHostLock: async () => "connection-1",
      claimCancelRedeliveryAttempt: async () => false,
      clearPendingCancelRedelivery: async (sessionId: string) => void cleared.push(sessionId),
    });
    let pushCount = 0;
    state.onHostMessage = () => void (pushCount += 1);

    await expect(redeliverPendingCancels(state)).resolves.toBe(0);

    expect(cleared).toEqual(["session-1"]);
    expect(pushCount).toBe(0);
  });

  it("honors shouldContinue to stop mid-page", async () => {
    const state = createControlPlaneState();
    setDurableReadStorage(state, {
      listPendingCancelRedeliveries: async () => [
        candidate({ sessionId: "session-1" }),
        candidate({ sessionId: "session-2" }),
      ],
      getHostLock: async () => "connection-1",
      claimCancelRedeliveryAttempt: async () => true,
      clearPendingCancelRedelivery: async () => undefined,
    });
    let pushCount = 0;
    state.onHostMessage = () => void (pushCount += 1);

    const result = await redeliverPendingCancels(state, 25, () => pushCount === 0);

    expect(result).toBe(1);
    expect(pushCount).toBe(1);
  });
});
