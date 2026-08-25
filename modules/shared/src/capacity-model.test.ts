import { describe, expect, it } from "vitest";

import {
  CAPACITY_CONSTANTS,
  REFERENCE_WORKLOAD,
  estimateMonthlyCapacity,
} from "./capacity-model.ts";

describe("capacity model", () => {
  it("scales log volume from the measured daemon coalesce rate", () => {
    const estimate = estimateMonthlyCapacity(REFERENCE_WORKLOAD);
    expect(estimate.logChunksPerSession).toBe(15 * 60 * CAPACITY_CONSTANTS.daemonLogMessagesPerSec);
    expect(estimate.dynamoLogWritesPerMonth).toBe(estimate.logChunksPerSession * 100 * 30);
    expect(estimate.dynamoLogTransactionsPerMonth).toBe(estimate.dynamoLogWritesPerMonth);
    expect(estimate.schedulerInvocationsPerMonth).toBe(30 * 24 * 60);
    expect(estimate.scheduleEvaluationsPerMonth).toBe(30 * 24 * 60 * 10);
    expect(estimate.archiveBytesPerMonth).toBe(100 * 30 * 256 * 1024);
    expect(estimate.queueAssignsPerDay).toBe(100);
    expect(estimate.lambdaInvocationsPerMonth).toBeGreaterThan(estimate.dynamoLogWritesPerMonth);
  });

  it("keeps a one-session day above zero", () => {
    const estimate = estimateMonthlyCapacity({
      sessionsPerDay: 1,
      sessionDurationSeconds: 1,
      connectedHosts: 1,
      connectedViewers: 0,
      schedules: 0,
      archiveBytesPerSession: 1,
    });
    expect(estimate.logChunksPerSession).toBe(CAPACITY_CONSTANTS.daemonLogMessagesPerSec);
    expect(estimate.dynamoLogWritesPerMonth).toBe(CAPACITY_CONSTANTS.daemonLogMessagesPerSec * 30);
  });

  it("includes every subscribed viewer copy in websocket volume", () => {
    const withoutViewers = estimateMonthlyCapacity({ ...REFERENCE_WORKLOAD, connectedViewers: 0 });
    const withViewers = estimateMonthlyCapacity({ ...REFERENCE_WORKLOAD, connectedViewers: 3 });
    expect(withViewers.websocketMessagesPerMonth - withoutViewers.websocketMessagesPerMonth).toBe(
      withoutViewers.dynamoLogWritesPerMonth * 3,
    );
    expect(withViewers.lambdaInvocationsPerMonth).toBe(withoutViewers.lambdaInvocationsPerMonth);
  });

  it("models every configured schedule evaluated by each repair sweep", () => {
    const withoutSchedules = estimateMonthlyCapacity({ ...REFERENCE_WORKLOAD, schedules: 0 });
    const withSchedules = estimateMonthlyCapacity({ ...REFERENCE_WORKLOAD, schedules: 37 });
    expect(withoutSchedules.scheduleEvaluationsPerMonth).toBe(0);
    expect(withSchedules.scheduleEvaluationsPerMonth).toBe(
      withSchedules.schedulerInvocationsPerMonth * 37,
    );
    // The EventBridge trigger remains one invocation per sweep; schedules add
    // in-invocation query/evaluation load, not one Lambda invocation each.
    expect(withSchedules.lambdaInvocationsPerMonth).toBe(
      withoutSchedules.lambdaInvocationsPerMonth,
    );
  });
});
