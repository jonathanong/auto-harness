import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

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
});
