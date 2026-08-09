import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { appendLogDurable } from "./control-plane-messages.ts";

describe("session log retention", () => {
  it("evicts over-budget records from memory and durable storage", async () => {
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
    expect(deleted).toEqual([["session-a", old.timestampSeq]]);
  });

  it("enforces the same retained-log caps in the durable log path", async () => {
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
    expect(deleted).toEqual([["session-durable", old.timestampSeq]]);
  });

  it("rejects an oversized durable log before persisting it", async () => {
    const plane = new ControlPlane({ storage: {} as never });

    await expect(
      plane.handleHostMessageDurable({
        type: "session:log",
        sessionId: "session-oversized",
        stream: "stdout",
        content: "x".repeat(32 * 1024 + 1),
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 0,
      }),
    ).resolves.toEqual({ ok: false, error: "log chunk exceeds 32 KiB" });
  });
});
