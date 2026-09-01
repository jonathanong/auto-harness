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

  it("redelivers to a connected host and bumps the attempt counter", async () => {
    const fixedNow = "2026-01-01T00:00:00.000Z";
    const state = createControlPlaneState({ now: () => fixedNow });
    const attempts: Array<{ sessionId: string; now: string }> = [];
    setDurableReadStorage(state, {
      listPendingCancelRedeliveries: async () => [candidate()],
      getHostLock: async () => "connection-1",
      recordCancelRedeliveryAttempt: async (sessionId: string, now: string) => {
        attempts.push({ sessionId, now });
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
    expect(attempts).toEqual([{ sessionId: "session-1", now: fixedNow }]);
  });

  it("stops redelivering and clears the marker once the host has disconnected", async () => {
    const state = createControlPlaneState();
    const cleared: string[] = [];
    setDurableReadStorage(state, {
      listPendingCancelRedeliveries: async () => [candidate()],
      getHostLock: async () => null,
      recordCancelRedeliveryAttempt: async () => undefined,
      clearPendingCancelRedelivery: async (sessionId: string) => void cleared.push(sessionId),
    });
    let pushCount = 0;
    state.onHostMessage = () => void (pushCount += 1);

    await expect(redeliverPendingCancels(state)).resolves.toBe(0);

    expect(cleared).toEqual(["session-1"]);
    expect(pushCount).toBe(0);
  });

  it("stops redelivering and clears the marker after the attempt bound is reached", async () => {
    const state = createControlPlaneState();
    const cleared: string[] = [];
    setDurableReadStorage(state, {
      listPendingCancelRedeliveries: async () => [
        candidate({ attempts: MAX_CANCEL_REDELIVERY_ATTEMPTS }),
      ],
      getHostLock: async () => "connection-1",
      recordCancelRedeliveryAttempt: async () => undefined,
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
      recordCancelRedeliveryAttempt: async () => undefined,
      clearPendingCancelRedelivery: async () => undefined,
    });
    let pushCount = 0;
    state.onHostMessage = () => void (pushCount += 1);

    const result = await redeliverPendingCancels(state, 25, () => pushCount === 0);

    expect(result).toBe(1);
    expect(pushCount).toBe(1);
  });
});
