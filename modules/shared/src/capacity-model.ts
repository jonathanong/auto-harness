/** Implementation-measured constants used by the AWS capacity/cost model. */

export const CAPACITY_CONSTANTS = {
  daemonLogMessagesPerSec: 10,
  controlPlaneLogBatchItems: 25,
  sessionLogsTtlSeconds: 7 * 24 * 3600,
  websocketKeepaliveSeconds: 20,
  schedulerIntervalSeconds: 60,
  apiGatewayMaxFrameBytes: 32 * 1024,
  dynamoItemMaxBytes: 400 * 1024,
  secondsPerMonth: 30 * 24 * 3600,
};

export type CapacityWorkload = {
  sessionsPerDay: number;
  sessionDurationSeconds: number;
  connectedHosts: number;
  connectedViewers: number;
  schedules: number;
  archiveBytesPerSession: number;
};

export type CapacityEstimate = {
  logChunksPerSession: number;
  dynamoLogWritesPerMonth: number;
  dynamoLogTransactionsPerMonth: number;
  websocketMessagesPerMonth: number;
  lambdaInvocationsPerMonth: number;
  schedulerInvocationsPerMonth: number;
  archiveBytesPerMonth: number;
  queueAssignsPerDay: number;
  connectionMinutes: number;
};

export const REFERENCE_WORKLOAD: CapacityWorkload = {
  sessionsPerDay: 100,
  sessionDurationSeconds: 15 * 60,
  connectedHosts: 2,
  connectedViewers: 2,
  schedules: 10,
  archiveBytesPerSession: 256 * 1024,
};

export function estimateMonthlyCapacity(workload: CapacityWorkload): CapacityEstimate {
  const logChunksPerSession = Math.max(
    1,
    Math.ceil(workload.sessionDurationSeconds * CAPACITY_CONSTANTS.daemonLogMessagesPerSec),
  );
  const sessionsPerMonth = workload.sessionsPerDay * 30;
  const dynamoLogWritesPerMonth = sessionsPerMonth * logChunksPerSession;
  const dynamoLogTransactionsPerMonth = Math.ceil(
    dynamoLogWritesPerMonth / CAPACITY_CONSTANTS.controlPlaneLogBatchItems,
  );
  const connectionMinutes =
    (workload.connectedHosts + workload.connectedViewers) *
    (CAPACITY_CONSTANTS.secondsPerMonth / 60);
  const keepalivesPerMonth =
    (workload.connectedHosts * CAPACITY_CONSTANTS.secondsPerMonth) /
    CAPACITY_CONSTANTS.websocketKeepaliveSeconds;
  const websocketMessagesPerMonth =
    dynamoLogWritesPerMonth + keepalivesPerMonth + sessionsPerMonth * 4;
  const schedulerInvocationsPerMonth =
    CAPACITY_CONSTANTS.secondsPerMonth / CAPACITY_CONSTANTS.schedulerIntervalSeconds;
  return {
    logChunksPerSession,
    dynamoLogWritesPerMonth,
    dynamoLogTransactionsPerMonth,
    websocketMessagesPerMonth,
    lambdaInvocationsPerMonth: websocketMessagesPerMonth + sessionsPerMonth * 10,
    schedulerInvocationsPerMonth,
    archiveBytesPerMonth: sessionsPerMonth * workload.archiveBytesPerSession,
    queueAssignsPerDay: workload.sessionsPerDay,
    connectionMinutes,
  };
}
