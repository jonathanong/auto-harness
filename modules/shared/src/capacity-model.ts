/** Implementation-measured constants used by the AWS capacity/cost model. */

export const CAPACITY_CONSTANTS = {
  daemonLogMessagesPerSec: 10,
  controlPlaneLogBatchItems: 25,
  sessionLogsTtlSeconds: 7 * 24 * 3600,
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
};

export type CapacityEstimate = {
  logChunksPerSession: number;
  /** Worst-case retained ordinary CLI log content, before archive JSONL overhead. */
  logBytesPerSession: number;
  dynamoLogWritesPerMonth: number;
  dynamoLogTransactionsPerMonth: number;
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
  const dynamoLogWritesPerMonth = sessionsPerMonth * logChunksPerSession;
  // API Gateway invokes the AWS WebSocket Lambda once per daemon log frame.
  // Local coalescing does not reduce the deployed transaction count.
  const dynamoLogTransactionsPerMonth = dynamoLogWritesPerMonth;
  const connectionMinutes =
    (workload.connectedHosts + workload.connectedViewers) *
    (CAPACITY_CONSTANTS.secondsPerMonth / 60);
  const keepalivesPerMonth =
    (workload.connectedHosts * CAPACITY_CONSTANTS.secondsPerMonth) /
    CAPACITY_CONSTANTS.websocketKeepaliveSeconds;
  const viewerLogMessagesPerMonth = dynamoLogWritesPerMonth * workload.connectedViewers;
  const inboundWebsocketMessagesPerMonth =
    dynamoLogWritesPerMonth + keepalivesPerMonth + sessionsPerMonth * 4;
  const websocketMessagesPerMonth = inboundWebsocketMessagesPerMonth + viewerLogMessagesPerMonth;
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
