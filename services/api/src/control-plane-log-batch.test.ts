/* eslint-disable max-lines -- omitted-attempt and mixed-host batch cases stay together. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { handleHostLogBatchDurable } from "./control-plane-messages.ts";
import { SESSION_LOGS_TTL_SECONDS } from "./db/dynamo.ts";
import { OPERATIONAL_METRIC_ENVIRONMENT_VAR } from "./operational-metrics.ts";

function withMetrics(): { payloads: () => Record<string, unknown>[] } {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR] = "test";
  return {
    payloads: () =>
      log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>),
  };
}

const message = (sessionId: string, seq: number, content = "x") => ({
  type: "session:log" as const,
  sessionId,
  attemptId: "a",
  stream: "stdout" as const,
  content,
  timestamp: "2026-01-01T00:00:00.000Z",
  seq,
});

/** A retained-cache entry for "session" at the given seq/timestamp. */
function cachedLog(seq: number, timestamp: string): Record<string, unknown> {
  return {
    sessionId: "session",
    timestampSeq: `${timestamp}#${String(seq).padStart(12, "0")}`,
    stream: "stdout",
    content: "x",
    timestamp,
    seq,
  };
}

/** Shared fixture for the seq-gap-detection tests: a "session" owned by
 * "host" on a fenced "connection", optionally pre-seeded with cached log
 * records, plus a metrics spy. */
function seqGapPlane(seedLogs?: Array<Record<string, unknown>>) {
  const plane = new ControlPlane();
  plane.state.sessions.set("session", { hostId: "host", attemptId: "a" } as never);
  if (seedLogs) plane.state.logs.set("session", seedLogs as never);
  plane.state.storage = {
    getSession: async () => ({ hostId: "host", attemptId: "a" }),
    getHostLock: async () => "connection",
    putLogsFenced: async () => true,
  } as never;
  return { plane, metrics: withMetrics() };
}

describe("durable host log batches", () => {
  afterEach(() => {
    delete process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR];
    vi.restoreAllMocks();
  });

  it("rejects empty and oversized batches", async () => {
    const plane = new ControlPlane();
    await expect(handleHostLogBatchDurable(plane.state, [], "connection")).resolves.toEqual({
      ok: false,
      error: "invalid log batch size",
    });
    await expect(
      handleHostLogBatchDurable(
        plane.state,
        Array.from({ length: 26 }, (_, seq) => message("session", seq)),
        "connection",
      ),
    ).resolves.toEqual({ ok: false, error: "invalid log batch size" });
  });

  it("uses the existing in-memory path when durable storage is absent", async () => {
    const plane = new ControlPlane();
    await expect(
      handleHostLogBatchDurable(
        plane.state,
        [message("session", 1), message("session", 2)],
        "local",
      ),
    ).resolves.toEqual({ ok: true });
    expect(plane.getLogs("session").map(({ seq }) => seq)).toEqual([1, 2]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const record of plane.getLogs("session")) {
      expect(record.ttl).toBeGreaterThanOrEqual(nowSeconds + SESSION_LOGS_TTL_SECONDS - 2);
      expect(record.ttl).toBeLessThanOrEqual(nowSeconds + SESSION_LOGS_TTL_SECONDS + 2);
    }
  });

  it("validates chunk bounds and a single current host lease", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("one", { hostId: "host-one", attemptId: "a" } as never);
    plane.state.sessions.set("two", { hostId: "host-two", attemptId: "a" } as never);
    plane.state.storage = {
      getSession: async (sessionId: string) =>
        sessionId === "one"
          ? { hostId: "host-one", attemptId: "a" }
          : sessionId === "two"
            ? { hostId: "host-two", attemptId: "a" }
            : null,
      getHostLock: async () => "other-connection",
    } as never;

    await expect(
      handleHostLogBatchDurable(
        plane.state,
        [message("one", 1, "x".repeat(32 * 1024 + 1))],
        "connection",
      ),
    ).resolves.toEqual({ ok: false, error: "log chunk exceeds 32 KiB" });
    await expect(
      handleHostLogBatchDurable(plane.state, [message("one", 1), message("two", 2)], "connection"),
    ).resolves.toEqual({ ok: false, error: "stale host connection" });
    await expect(
      handleHostLogBatchDurable(plane.state, [message("one", 1)], "connection"),
    ).resolves.toEqual({ ok: false, error: "stale host connection" });
  });

  it("commits, retains, and publishes a fenced batch in sequence order", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("session", { hostId: "host", attemptId: "a" } as never);
    plane.state.logs.set(
      "session",
      Array.from({ length: 10_000 }, (_, seq) => ({
        sessionId: "session",
        timestampSeq: `2025-01-01T00:00:00.000Z#${String(seq).padStart(12, "0")}`,
        stream: "stdout",
        content: "old",
        timestamp: "2025-01-01T00:00:00.000Z",
        seq,
      })),
    );
    const written: number[][] = [];
    const deleted: number[] = [];
    const published: number[] = [];
    plane.state.onLogCommitted = (record) => published.push(record.seq);
    plane.state.storage = {
      getSession: async () => ({ hostId: "host", attemptId: "a" }),
      getHostLock: async () => "connection",
      putLogsFenced: async (records: Array<{ seq: number; ttl?: number }>) => {
        written.push(records.map(({ seq }) => seq));
        const nowSeconds = Math.floor(Date.now() / 1000);
        for (const record of records) {
          expect(record.ttl).toBeGreaterThanOrEqual(nowSeconds + SESSION_LOGS_TTL_SECONDS - 2);
          expect(record.ttl).toBeLessThanOrEqual(nowSeconds + SESSION_LOGS_TTL_SECONDS + 2);
        }
        return true;
      },
      deleteLog: async (_sessionId: string, timestampSeq: string) => {
        deleted.push(Number(timestampSeq.slice(-12)));
      },
    } as never;

    await expect(
      handleHostLogBatchDurable(
        plane.state,
        [message("session", 10_000), message("session", 10_001)],
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    expect(written).toEqual([[10_000, 10_001]]);
    // Eviction bounds the cache only; the durable transcript stays whole.
    expect(deleted).toEqual([]);
    expect(published).toEqual([10_000, 10_001]);
    expect(
      plane
        .getLogs("session")
        .slice(-2)
        .map(({ seq }) => seq),
    ).toEqual([10_000, 10_001]);

    plane.state.storage.putLogsFenced = async () => false;
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 10_002)], "connection"),
    ).resolves.toEqual({ ok: false, error: "stale host connection" });
  });

  it("uses an authoritative session row when the cache has no owner", async () => {
    const plane = new ControlPlane();
    plane.state.storage = {
      getSession: async () => ({ hostId: "host", attemptId: "a" }),
      getHostLock: async () => "connection",
      putLogsFenced: async () => true,
      deleteLog: async () => {},
    } as never;
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 1)], "connection"),
    ).resolves.toEqual({ ok: true });
  });

  it("ignores cached attempts and writes only the durable current attempt", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("session", { hostId: "host", attemptId: "old" } as never);
    const written: string[] = [];
    plane.state.storage = {
      getSession: async () => ({ hostId: "host", attemptId: "a" }),
      getHostLock: async () => "connection",
      putLogsFenced: async (records: Array<{ content: string }>) => (
        written.push(...records.map((record) => record.content)),
        true
      ),
    } as never;
    const metrics = withMetrics();
    await expect(
      handleHostLogBatchDurable(
        plane.state,
        [{ ...message("session", 1, "stale"), attemptId: "old" }, message("session", 2, "current")],
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    expect(written).toEqual(["current"]);
    // The stale-attempt discard gets its own counter (a known, named cause);
    // no LogSeqGaps fires alongside it since the cache had no prior seq for
    // this session to compare against (an empty ControlPlane, fresh test).
    expect(metrics.payloads()).toEqual([expect.objectContaining({ StaleAttemptLogDrops: 1 })]);
  });

  it("fences a batch by the resolved current attempt, including omitted ids", async () => {
    const plane = new ControlPlane();
    const fences: Array<{ attempts?: Array<{ sessionId: string; attemptId: string }> }> = [];
    plane.state.storage = {
      getSession: async () => ({ hostId: "host", attemptId: "a" }),
      getHostLock: async () => "connection",
      putLogsFenced: async (
        _records: unknown,
        fence: { attempts?: Array<{ sessionId: string; attemptId: string }> },
      ) => (fences.push(fence), true),
    } as never;
    await expect(
      handleHostLogBatchDurable(
        plane.state,
        [
          {
            type: "session:log",
            sessionId: "session",
            stream: "stdout",
            content: "legacy",
            timestamp: "2026-01-01T00:00:00.000Z",
            seq: 1,
          },
          message("session", 2, "current"),
        ],
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    expect(fences).toEqual([
      {
        hostId: "host",
        connectionId: "connection",
        attempts: [
          { sessionId: "session", attemptId: "a" },
          { sessionId: "session", attemptId: "a" },
        ],
      },
    ]);
  });

  it("writes a batch without attempt fences when no attempt id can be resolved", async () => {
    const plane = new ControlPlane();
    const fences: Array<{ attempts?: unknown }> = [];
    plane.state.storage = {
      getSession: async () => ({ hostId: "host" }),
      getHostLock: async () => "connection",
      putLogsFenced: async (_records: unknown, fence: { attempts?: unknown }) => (
        fences.push(fence),
        true
      ),
    } as never;
    await expect(
      handleHostLogBatchDurable(
        plane.state,
        [
          {
            type: "session:log",
            sessionId: "session",
            stream: "stdout",
            content: "legacy",
            timestamp: "2026-01-01T00:00:00.000Z",
            seq: 1,
          },
        ],
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    expect(fences).toEqual([{ hostId: "host", connectionId: "connection" }]);
  });

  it("detects a seq gap against a known cache baseline and reports the missing count", async () => {
    const { plane, metrics } = seqGapPlane([cachedLog(5, "2026-01-01T00:00:00.000Z")]);
    // Skips 6 and 7: two missing lines between the cached seq 5 and this seq 8.
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 8)], "connection"),
    ).resolves.toEqual({ ok: true });
    expect(metrics.payloads()).toEqual([expect.objectContaining({ LogSeqGaps: 2 })]);
  });

  it("finds the true highest seq even when a clock-skewed timestamp orders it before a lower one", async () => {
    // retainLogs orders the cache by timestampSeq, not by seq: if the source
    // clock ever moves backward, a higher-seq record can land earlier in the
    // array than a lower-seq one with a later timestamp. The array's last
    // element (seq 6) is not the true highest seq (seq 9, stored earlier).
    const { plane, metrics } = seqGapPlane([
      cachedLog(9, "2026-01-01T00:00:00.000Z"),
      cachedLog(6, "2026-01-01T00:00:01.000Z"),
    ]);
    // Correctly compared against the true max (9), not the last array
    // element (6): seq 10 is a plain contiguous next line, not a gap.
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 10)], "connection"),
    ).resolves.toEqual({ ok: true });
    expect(metrics.payloads()).toEqual([]);
  });

  it("detects an intra-batch seq gap between two records in the same batch", async () => {
    const { plane, metrics } = seqGapPlane();
    // No cached baseline, so the first record (seq 1) reports nothing; the
    // second (seq 4) is checked against the first, now committed within
    // this same call, and reports the 2 lines missing between them (2, 3).
    await expect(
      handleHostLogBatchDurable(
        plane.state,
        [message("session", 1), message("session", 4)],
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    expect(metrics.payloads()).toEqual([expect.objectContaining({ LogSeqGaps: 2 })]);
  });

  it("does not report a gap for a fresh attempt's first line, a replayed seq, or an unknown cache baseline", async () => {
    const { plane, metrics } = seqGapPlane();
    // seq 0: always a legitimate fresh-attempt start, never a gap, even
    // though the cache is empty (unknown) either way.
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 0)], "connection"),
    ).resolves.toEqual({ ok: true });
    // seq 1: a normal contiguous line, establishing a real cache baseline.
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 1)], "connection"),
    ).resolves.toEqual({ ok: true });
    // seq 1 again: a reconnect replay/duplicate, not a forward jump past the
    // now-known baseline of 1.
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 1)], "connection"),
    ).resolves.toEqual({ ok: true });
    expect(metrics.payloads()).toEqual([]);
  });
});
