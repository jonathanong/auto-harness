import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPERATIONAL_METRIC_ENVIRONMENT_VAR,
  OPERATIONAL_METRIC_NAMESPACE,
  OPERATIONAL_METRICS,
  emitAssignmentFailure,
  emitCooldown,
  emitCronSweepMetrics,
  emitLogDrops,
  emitOperationalMetric,
  queuedSessionAgeSeconds,
} from "./operational-metrics.ts";

describe("operational metrics", () => {
  afterEach(() => {
    delete process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR];
    vi.restoreAllMocks();
  });

  it("computes oldest queued session age and ignores invalid rows", () => {
    expect(queuedSessionAgeSeconds([], 10_000)).toBe(0);
    expect(
      queuedSessionAgeSeconds(
        [
          { status: "running", createdAt: "2026-01-01T00:00:00.000Z" },
          { status: "queued", createdAt: "not-a-date" },
        ],
        Date.parse("2026-01-01T00:10:00.000Z"),
      ),
    ).toBe(0);
    expect(
      queuedSessionAgeSeconds(
        [
          { status: "queued", createdAt: "2026-01-01T00:08:00.000Z" },
          { status: "queued", createdAt: "2026-01-01T00:05:00.000Z" },
          { status: "completed", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
        Date.parse("2026-01-01T00:10:00.000Z"),
      ),
    ).toBe(300);
  });

  it("no-ops without an environment and emits EMF when configured", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    emitOperationalMetric(OPERATIONAL_METRICS.logDrops, 2);
    emitLogDrops(0);
    emitLogDrops(undefined);
    expect(log).not.toHaveBeenCalled();

    process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR] = "ReviewRuntime";
    emitOperationalMetric("Broken", Number.NaN);
    expect(log).not.toHaveBeenCalled();

    emitOperationalMetric(OPERATIONAL_METRICS.logDrops, 4, "Count", () => 1_700_000_000_000);
    emitCooldown();
    emitAssignmentFailure();
    emitCronSweepMetrics({ ackTimeouts: 2, staleHosts: 1, queueAgeSeconds: 45 });
    const payloads = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Environment: "ReviewRuntime",
          LogDrops: 4,
          _aws: expect.objectContaining({
            CloudWatchMetrics: [
              expect.objectContaining({ Namespace: OPERATIONAL_METRIC_NAMESPACE }),
            ],
          }),
        }),
        expect.objectContaining({ Cooldowns: 1 }),
        expect.objectContaining({ AssignmentFailures: 1 }),
        expect.objectContaining({ AckTimeouts: 2 }),
        expect.objectContaining({ StaleHosts: 1 }),
        expect.objectContaining({ QueueAgeSeconds: 45 }),
      ]),
    );
  });
});
