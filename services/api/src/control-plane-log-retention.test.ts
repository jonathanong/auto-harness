import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { appendLogDurable } from "./control-plane-messages.ts";

/**
 * The retained-log window is a replay cache, not a retention policy. Eviction used to
 * delete the evicted rows from storage too, which silently destroyed the beginning of
 * any session that outgrew the window — including the copy archiveSessionLogs reads.
 */
describe("session log retention", () => {
  it("drops over-budget records from memory while leaving storage intact", async () => {
    const deleted: Array<[string, string]> = [];
    const storage = {
      putLog: async () => undefined,
      deleteLog: async (sessionId: string, timestampSeq: string) => {
        deleted.push([sessionId, timestampSeq]);
      },
    };
    const plane = new ControlPlane({ storage: storage as never });
    const old = plane.appendLog({
      sessionId: "session-a",
      stream: "stdout",
      content: "x".repeat(10 * 1024 * 1024),
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 0,
    });
    plane.appendLog({
      sessionId: "session-a",
      stream: "stdout",
      content: "new",
      timestamp: "2026-01-01T00:00:01.000Z",
      seq: 1,
    });
    await plane.settleStorage();

    expect(plane.getLogs("session-a")).toEqual([
      expect.objectContaining({ content: "new", seq: 1 }),
    ]);
    expect(old.timestampSeq).toBeTruthy();
    expect(deleted).toEqual([]);
  });

  it("bounds memory in the durable log path without deleting the transcript", async () => {
    const deleted: Array<[string, string]> = [];
    const storage = {
      putLog: async () => undefined,
      deleteLog: async (sessionId: string, timestampSeq: string) => {
        deleted.push([sessionId, timestampSeq]);
      },
    };
    const plane = new ControlPlane({ storage: storage as never });
    const old = await appendLogDurable(plane.state, {
      sessionId: "session-durable",
      stream: "stdout",
      content: "x".repeat(10 * 1024 * 1024),
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 0,
    });
    await appendLogDurable(plane.state, {
      sessionId: "session-durable",
      stream: "stdout",
      content: "new",
      timestamp: "2026-01-01T00:00:01.000Z",
      seq: 1,
    });

    expect(plane.getLogs("session-durable")).toEqual([
      expect.objectContaining({ content: "new", seq: 1 }),
    ]);
    expect(old.timestampSeq).toBeTruthy();
    expect(deleted).toEqual([]);
  });

  it("archives the whole transcript for a session that outgrew the window", async () => {
    const stored: Array<{ sessionId: string; timestampSeq: string; content: string }> = [];
    const deleted: string[] = [];
    const storage = {
      putLog: async (record: { sessionId: string; timestampSeq: string; content: string }) => {
        stored.push(record);
      },
      // Records the attempt as well as applying it: whether a delete racing the write
      // actually removes the row is timing, but attempting it at all is the defect.
      deleteLog: async (sessionId: string, timestampSeq: string) => {
        deleted.push(timestampSeq);
        const index = stored.findIndex(
          (record) => record.sessionId === sessionId && record.timestampSeq === timestampSeq,
        );
        if (index >= 0) stored.splice(index, 1);
      },
      listLogs: async (sessionId: string) => stored.filter((r) => r.sessionId === sessionId),
      putArchive: async () => undefined,
    };
    const plane = new ControlPlane({ storage: storage as never });
    plane.appendLog({
      sessionId: "session-big",
      stream: "stdout",
      content: `FIRST${"x".repeat(10 * 1024 * 1024)}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 0,
    });
    plane.appendLog({
      sessionId: "session-big",
      stream: "stdout",
      content: "LAST",
      timestamp: "2026-01-01T00:00:01.000Z",
      seq: 1,
    });
    await plane.settleStorage();

    // Only the tail is cached, but the archive is built from storage and must be whole.
    expect(plane.getLogs("session-big")).toHaveLength(1);
    expect(deleted).toEqual([]);
    const archived = await plane.archiveSessionLogs("session-big");
    expect(archived.body).toContain("FIRST");
    expect(archived.body).toContain("LAST");
  });

  it("rejects an oversized durable log before persisting it", async () => {
    const plane = new ControlPlane({ storage: {} as never });

    await expect(
      plane.handleHostMessageDurable({
        type: "session:log",
        sessionId: "session-oversized",
        attemptId: "a",
        stream: "stdout",
        content: "x".repeat(32 * 1024 + 1),
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 0,
      }),
    ).resolves.toEqual({ ok: false, error: "log chunk exceeds 32 KiB" });
  });
});
