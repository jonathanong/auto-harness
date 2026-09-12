import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable archive reads", () => {
  it("exposes an integrity-incomplete transcript without signing it", async () => {
    const plane = new ControlPlane({
      archiveReader: {
        createDownload: async () => ({
          available: false,
          reason: "content-length-mismatch",
        }),
      },
    });
    plane.state.archives.set("sessions/session/logs.jsonl", {
      key: "sessions/session/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "incomplete",
      reason: "content-length-mismatch",
    });
  });
});
