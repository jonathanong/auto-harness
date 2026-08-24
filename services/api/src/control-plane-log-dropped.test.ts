import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { handleHostMessage } from "./control-plane-messages.ts";

describe("source-side drop telemetry ingest", () => {
  it("persists dropped counts on session log records", () => {
    const plane = new ControlPlane();
    expect(
      handleHostMessage(plane.state, {
        type: "session:log",
        sessionId: "session",
        attemptId: "a",
        stream: "system",
        content: "3 log chunk(s) dropped",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 4,
        dropped: 3,
      }),
    ).toEqual({ ok: true });
    expect(plane.getLogs("session")[0]).toEqual(
      expect.objectContaining({ seq: 4, dropped: 3, content: "3 log chunk(s) dropped" }),
    );
  });
});
