import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable archive reads", () => {
  it("distinguishes terminal transcripts whose recent-log retention has expired", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-08T00:00:00.000Z" });
    const key = "sessions/session/logs.jsonl";
    plane.state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "pending",
      objectStored: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "expired" });
    plane.state.archives.delete(key);
    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "expired" });
    await expect(plane.getArchiveDownloadDurable("session", "invalid")).resolves.toEqual({
      state: "dynamodb",
    });
  });

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
