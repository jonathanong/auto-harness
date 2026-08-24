import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { handleHostLogBatchDurable } from "./control-plane-messages.ts";
import { SESSION_LOGS_TTL_SECONDS } from "./db/dynamo.ts";

const message = (sessionId: string, seq: number, content = "x") => ({
  type: "session:log" as const,
  sessionId,
  attemptId: "a",
  stream: "stdout" as const,
  content,
  timestamp: "2026-01-01T00:00:00.000Z",
  seq,
});

describe("durable host log batches", () => {
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
      getSession: async () => null,
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
      getSession: async () => null,
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
      getSession: async () => ({ hostId: "host" }),
      getHostLock: async () => "connection",
      putLogsFenced: async () => true,
      deleteLog: async () => {},
    } as never;
    await expect(
      handleHostLogBatchDurable(plane.state, [message("session", 1)], "connection"),
    ).resolves.toEqual({ ok: true });
  });
});
