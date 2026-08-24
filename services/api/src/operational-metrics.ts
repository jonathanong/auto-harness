/** Keep in sync with services/cdk/src/runtime-observability.ts. */
export const OPERATIONAL_METRIC_NAMESPACE = "AutoHarness";
export const OPERATIONAL_METRIC_ENVIRONMENT_VAR = "HARNESS_METRIC_ENVIRONMENT";

export const OPERATIONAL_METRICS = {
  ackTimeouts: "AckTimeouts",
  assignmentFailures: "AssignmentFailures",
  cooldowns: "Cooldowns",
  logDrops: "LogDrops",
  queueAgeSeconds: "QueueAgeSeconds",
  staleHosts: "StaleHosts",
} as const;

export function emitOperationalMetric(
  name: string,
  value: number,
  unit: "Count" | "Seconds" = "Count",
  now = Date.now,
): void {
  const environment = process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR];
  if (!environment || !Number.isFinite(value)) return;
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [
          {
            Dimensions: [["Environment"]],
            Metrics: [{ Name: name, Unit: unit }],
            Namespace: OPERATIONAL_METRIC_NAMESPACE,
          },
        ],
      },
      Environment: environment,
      [name]: value,
    }),
  );
}

export function queuedSessionAgeSeconds(
  sessions: readonly { status: string; createdAt: string }[],
  nowMs: number,
): number {
  let oldest: number | undefined;
  for (const session of sessions) {
    if (session.status !== "queued") continue;
    const created = Date.parse(session.createdAt);
    if (!Number.isFinite(created)) continue;
    oldest = oldest === undefined ? created : Math.min(oldest, created);
  }
  if (oldest === undefined) return 0;
  return Math.max(0, Math.floor((nowMs - oldest) / 1000));
}

export function emitLogDrops(dropped: number | undefined): void {
  if (dropped !== undefined && dropped > 0) {
    emitOperationalMetric(OPERATIONAL_METRICS.logDrops, dropped);
  }
}

export function emitCooldown(): void {
  emitOperationalMetric(OPERATIONAL_METRICS.cooldowns, 1);
}

export function emitAssignmentFailure(): void {
  emitOperationalMetric(OPERATIONAL_METRICS.assignmentFailures, 1);
}

export function emitCronSweepMetrics(input: {
  ackTimeouts: number;
  staleHosts: number;
  queueAgeSeconds: number;
}): void {
  emitOperationalMetric(OPERATIONAL_METRICS.ackTimeouts, input.ackTimeouts);
  emitOperationalMetric(OPERATIONAL_METRICS.staleHosts, input.staleHosts);
  emitOperationalMetric(OPERATIONAL_METRICS.queueAgeSeconds, input.queueAgeSeconds, "Seconds");
}
