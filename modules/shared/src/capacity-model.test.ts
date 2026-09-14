import { describe, expect, it } from "vitest";

import {
  CAPACITY_CONSTANTS,
  REFERENCE_WORKLOAD,
  estimateMonthlyCapacity,
} from "./capacity-model.ts";

describe("capacity model", () => {
  it("does not put log bodies in DynamoDB", () => {
    const estimate = estimateMonthlyCapacity(REFERENCE_WORKLOAD);
    expect(estimate.logChunksPerSession).toBe(15 * 60 * CAPACITY_CONSTANTS.daemonLogMessagesPerSec);
    expect(estimate.logBytesPerSession).toBe(CAPACITY_CONSTANTS.sessionLogMaxBytes);
    expect(estimate.dynamoLogWritesPerMonth).toBe(0);
    expect(estimate.dynamoLogTransactionsPerMonth).toBe(0);
    expect(estimate.s3PartPutsPerMonth).toBe(0);
    expect(estimate.s3FinalPutsPerMonth).toBe(0);
    expect(estimate.schedulerInvocationsPerMonth).toBe(30 * 24 * 60);
    expect(estimate.scheduleEvaluationsPerMonth).toBe(30 * 24 * 60 * 10);
    expect(estimate.archiveBytesPerMonth).toBe(100 * 30 * 256 * 1024);
    expect(estimate.queueAssignsPerDay).toBe(100);
  });

  it("counts one-minute gzip parts when upload is on", () => {
    const estimate = estimateMonthlyCapacity({ ...REFERENCE_WORKLOAD, sessionLogUpload: true });
    expect(estimate.s3PartPutsPerMonth).toBe(100 * 30 * 15);
    expect(estimate.s3FinalPutsPerMonth).toBe(100 * 30);
    expect(estimate.dynamoLogWritesPerMonth).toBe(0);
  });

  it("keeps a one-session day above zero without Dynamo log writes", () => {
    const estimate = estimateMonthlyCapacity({
      sessionsPerDay: 1,
      sessionDurationSeconds: 1,
      connectedHosts: 1,
      connectedViewers: 0,
      schedules: 0,
      archiveBytesPerSession: 1,
    });
    expect(estimate.logChunksPerSession).toBe(CAPACITY_CONSTANTS.daemonLogMessagesPerSec);
    expect(estimate.dynamoLogWritesPerMonth).toBe(0);
    expect(estimate.s3PartPutsPerMonth).toBe(0);
  });

  it("notifies watching viewers per part, not per log line", () => {
    const withoutViewers = estimateMonthlyCapacity({
      ...REFERENCE_WORKLOAD,
      sessionLogUpload: true,
      connectedViewers: 0,
    });
    const withViewers = estimateMonthlyCapacity({
      ...REFERENCE_WORKLOAD,
      sessionLogUpload: true,
      connectedViewers: 3,
    });
    expect(withViewers.websocketMessagesPerMonth - withoutViewers.websocketMessagesPerMonth).toBe(
      withoutViewers.s3PartPutsPerMonth * 3,
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
    expect(withSchedules.lambdaInvocationsPerMonth).toBe(
      withoutSchedules.lambdaInvocationsPerMonth,
    );
  });

  it("caps long-running session log estimates at the streamer's chunk and byte budgets", () => {
    const estimate = estimateMonthlyCapacity({
      ...REFERENCE_WORKLOAD,
      sessionDurationSeconds: CAPACITY_CONSTANTS.sessionLogMaxChunks,
    });
    expect(estimate.logChunksPerSession).toBe(CAPACITY_CONSTANTS.sessionLogMaxChunks);
    expect(estimate.logBytesPerSession).toBe(CAPACITY_CONSTANTS.sessionLogMaxBytes);
    expect(estimate.dynamoLogWritesPerMonth).toBe(0);
  });

  it("counts each keepalive twice: inbound frame plus outbound ack", () => {
    const keepalivesPerHost =
      CAPACITY_CONSTANTS.secondsPerMonth / CAPACITY_CONSTANTS.websocketKeepaliveSeconds;
    const oneHost = estimateMonthlyCapacity({
      sessionsPerDay: 0,
      sessionDurationSeconds: 0,
      connectedHosts: 1,
      connectedViewers: 0,
      schedules: 0,
      archiveBytesPerSession: 0,
    });
    const twoHosts = estimateMonthlyCapacity({
      sessionsPerDay: 0,
      sessionDurationSeconds: 0,
      connectedHosts: 2,
      connectedViewers: 0,
      schedules: 0,
      archiveBytesPerSession: 0,
    });
    expect(oneHost.websocketMessagesPerMonth).toBe(keepalivesPerHost * 2);
    expect(twoHosts.websocketMessagesPerMonth).toBe(keepalivesPerHost * 4);
    expect(oneHost.lambdaInvocationsPerMonth).toBe(
      keepalivesPerHost + oneHost.schedulerInvocationsPerMonth,
    );
  });

  it("includes each scheduled repair sweep in Lambda requests", () => {
    const estimate = estimateMonthlyCapacity({
      sessionsPerDay: 0,
      sessionDurationSeconds: 0,
      connectedHosts: 0,
      connectedViewers: 0,
      schedules: 0,
      archiveBytesPerSession: 0,
    });
    expect(estimate.lambdaInvocationsPerMonth).toBe(estimate.schedulerInvocationsPerMonth);
  });
});
