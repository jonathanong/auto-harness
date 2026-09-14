/** Implementation-measured constants used by the AWS capacity/cost model. */

import { DEFAULT_SESSION_LOG_SETTINGS } from "./session-log-settings.ts";

export const CAPACITY_CONSTANTS = {
  daemonLogMessagesPerSec: 10,
  /** Host gzip-part flush; control-plane UI poll uses the same default. */
  sessionLogBatchMaxWaitSeconds: DEFAULT_SESSION_LOG_SETTINGS.batchMaxWaitMs / 1000,
  websocketKeepaliveSeconds: 20,
  schedulerIntervalSeconds: 60,
  apiGatewayMaxFrameBytes: 32 * 1024,
  /** Largest log content payload after leaving room for a JSON WS envelope. */
  daemonLogPayloadMaxBytes: Math.floor((32 * 1024 - 512) / 6),
  /** LogStreamer drops ordinary CLI output after either of these per-session bounds. */
  sessionLogMaxChunks: 10_000,
  sessionLogMaxBytes: 10 * 1024 * 1024,
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
  /** When false (default), no S3 log parts are modelled. */
  sessionLogUpload?: boolean;
};

export type CapacityEstimate = {
  logChunksPerSession: number;
  /** Worst-case retained ordinary CLI log content, before archive JSONL overhead. */
  logBytesPerSession: number;
  /** Always 0: log bodies are not DynamoDB items. */
  dynamoLogWritesPerMonth: number;
  dynamoLogTransactionsPerMonth: number;
  s3PartPutsPerMonth: number;
  s3FinalPutsPerMonth: number;
  websocketMessagesPerMonth: number;
  lambdaInvocationsPerMonth: number;
  schedulerInvocationsPerMonth: number;
  /** Number of individual durable schedule records examined by the repair sweep. */
  scheduleEvaluationsPerMonth: number;
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
  const uncappedLogChunksPerSession = Math.max(
    1,
    Math.ceil(workload.sessionDurationSeconds * CAPACITY_CONSTANTS.daemonLogMessagesPerSec),
  );
  // LogStreamer bounds a session both by emitted chunk count and retained
  // payload bytes. The byte budget is reported separately: small chunks can
  // reach the chunk limit before it, while full-size chunks reach bytes first.
  const logChunksPerSession = Math.min(
    uncappedLogChunksPerSession,
    CAPACITY_CONSTANTS.sessionLogMaxChunks,
  );
  const logBytesPerSession = Math.min(
    logChunksPerSession * CAPACITY_CONSTANTS.daemonLogPayloadMaxBytes,
    CAPACITY_CONSTANTS.sessionLogMaxBytes,
  );
  const sessionsPerMonth = workload.sessionsPerDay * 30;
  const dynamoLogWritesPerMonth = 0;
  const dynamoLogTransactionsPerMonth = 0;
  const partsPerSession = Math.max(
    1,
    Math.ceil(workload.sessionDurationSeconds / CAPACITY_CONSTANTS.sessionLogBatchMaxWaitSeconds),
  );
  const upload = workload.sessionLogUpload === true;
  const s3PartPutsPerMonth = upload ? sessionsPerMonth * partsPerSession : 0;
  const s3FinalPutsPerMonth = upload ? sessionsPerMonth : 0;
  const connectionMinutes =
    (workload.connectedHosts + workload.connectedViewers) *
    (CAPACITY_CONSTANTS.secondsPerMonth / 60);
  const keepalivesPerMonth =
    (workload.connectedHosts * CAPACITY_CONSTANTS.secondsPerMonth) /
    CAPACITY_CONSTANTS.websocketKeepaliveSeconds;
  const keepaliveAcksPerMonth = keepalivesPerMonth;
  // Log bodies do not traverse API Gateway. Optional part-ready notifies are one
  // outbound frame per part per watching viewer.
  const viewerPartNotifiesPerMonth = upload ? s3PartPutsPerMonth * workload.connectedViewers : 0;
  const inboundWebsocketMessagesPerMonth = keepalivesPerMonth + sessionsPerMonth * 4;
  const websocketMessagesPerMonth =
    inboundWebsocketMessagesPerMonth + keepaliveAcksPerMonth + viewerPartNotifiesPerMonth;
  const schedulerInvocationsPerMonth =
    CAPACITY_CONSTANTS.secondsPerMonth / CAPACITY_CONSTANTS.schedulerIntervalSeconds;
  // One EventBridge/Lambda invocation runs per sweep, but it scans/evaluates
  // every configured durable schedule. Keep that per-record load visible so a
  // low session count cannot disguise a large scheduler query/conditional-write
  // workload.
  const scheduleEvaluationsPerMonth = schedulerInvocationsPerMonth * workload.schedules;
  return {
    logChunksPerSession,
    logBytesPerSession,
    dynamoLogWritesPerMonth,
    dynamoLogTransactionsPerMonth,
    s3PartPutsPerMonth,
    s3FinalPutsPerMonth,
    websocketMessagesPerMonth,
    // Viewer fanout is an outbound gateway message, not an invocation of the WebSocket Lambda.
    lambdaInvocationsPerMonth:
      inboundWebsocketMessagesPerMonth + sessionsPerMonth * 10 + schedulerInvocationsPerMonth,
    schedulerInvocationsPerMonth,
    scheduleEvaluationsPerMonth,
    archiveBytesPerMonth: sessionsPerMonth * workload.archiveBytesPerSession,
    queueAssignsPerDay: workload.sessionsPerDay,
    connectionMinutes,
  };
}
