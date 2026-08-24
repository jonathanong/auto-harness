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
    expect(estimate.dynamoLogTransactionsPerMonth).toBe(
      Math.ceil(estimate.dynamoLogWritesPerMonth / 25),
    );
    expect(estimate.schedulerInvocationsPerMonth).toBe(30 * 24 * 60);
    expect(estimate.archiveBytesPerMonth).toBe(100 * 30 * 256 * 1024);
    expect(estimate.queueAssignsPerDay).toBe(100);
    expect(estimate.lambdaInvocationsPerMonth).toBeGreaterThan(estimate.websocketMessagesPerMonth);
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
});
