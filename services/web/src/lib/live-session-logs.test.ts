import { describe, expect, it } from "vitest";

import {
  lastLiveCursor,
  liveLogsStateLabel,
  mergeInitialLiveLogs,
  mergeLiveLogs,
  resolveViewerSessionStatus,
  validLiveLog,
  viewerWebSocketUrl,
  viewerTicket,
} from "./live-session-logs.ts";

const first = {
  timestampSeq: "2026-08-10T12:00:00.000Z#0000000001",
  timestamp: "2026-08-10T12:00:00.000Z",
  seq: 1,
  stream: "stdout",
  content: "first",
};

describe("live session log status labels", () => {
  it("prefers a terminal REST status over a later subscribe queued or running", () => {
    expect(resolveViewerSessionStatus("completed", "queued")).toBe("completed");
    expect(resolveViewerSessionStatus("failed", "queued")).toBe("failed");
    expect(resolveViewerSessionStatus("cancelled", "queued")).toBe("cancelled");
    expect(resolveViewerSessionStatus("timed_out", "queued")).toBe("timed_out");
    expect(resolveViewerSessionStatus("queued", "queued")).toBe("queued");
    expect(resolveViewerSessionStatus("queued", "running")).toBe("running");
    expect(resolveViewerSessionStatus("running", "completed")).toBe("completed");
    expect(resolveViewerSessionStatus("completed", "running")).toBe("completed");
    expect(resolveViewerSessionStatus("completed", "failed")).toBe("failed");
  });

  it("omits Live — for terminal sessions and keeps it for active ones", () => {
    expect(liveLogsStateLabel("connecting", "completed")).toBe("Connecting live logs…");
    expect(liveLogsStateLabel("reconnecting", "queued")).toBe("Reconnecting live logs…");
    expect(liveLogsStateLabel("error", "failed")).toBe("Live logs unavailable");
    expect(liveLogsStateLabel("live", "running")).toBe("Live — running");
    expect(liveLogsStateLabel("live", "queued")).toBe("Live — queued");
    expect(liveLogsStateLabel("live", "completed")).toBe("completed");
    expect(liveLogsStateLabel("live", "failed")).toBe("failed");
    expect(liveLogsStateLabel("live", "cancelled")).toBe("cancelled");
    expect(liveLogsStateLabel("live", "timed_out")).toBe("timed_out");
  });
});

describe("live session log state", () => {
  it("orders history, deduplicates reconnect replay, and bounds retained output", () => {
    const second = { ...first, timestampSeq: "2026-08-10T12:00:01.000Z#0000000002", seq: 2 };
    const third = { ...first, timestampSeq: "2026-08-10T12:00:02.000Z#0000000003", seq: 3 };
    let entries = mergeInitialLiveLogs([second, first, second]);
    expect(mergeLiveLogs([], first)).toEqual([first]);
    entries = mergeLiveLogs(entries, third, 2);

    expect(entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(lastLiveCursor(entries)).toBe(third.timestampSeq);
  });

  it("inserts out-of-order replay, replaces a matching cursor, and still bounds output", () => {
    const second = { ...first, timestampSeq: "2026-08-10T12:00:01.000Z#0000000002", seq: 2 };
    const third = { ...first, timestampSeq: "2026-08-10T12:00:02.000Z#0000000003", seq: 3 };
    const replayed = { ...second, content: "replayed" };
    expect(mergeLiveLogs([first, third], second).map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(mergeLiveLogs([first, second], replayed)).toEqual([first, replayed]);
    expect(mergeLiveLogs([second, third], first, 2).map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("keeps existing entries for malformed frames and validates all supported streams", () => {
    expect(mergeLiveLogs([first], { ...first, seq: -1 })).toEqual([first]);
    expect(validLiveLog(null)).toBe(false);
    expect(validLiveLog({ ...first, stream: "stderr" })).toBe(true);
    expect(validLiveLog({ ...first, stream: "system" })).toBe(true);
    expect(validLiveLog({ ...first, stream: "other" })).toBe(false);
    expect(validLiveLog({ ...first, timestampSeq: "" })).toBe(false);
    expect(validLiveLog({ ...first, content: 1 })).toBe(false);
  });

  it("uses an explicit viewer endpoint when configured", () => {
    const original = process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
    process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL = "wss://logs.example.test/ws/viewer";
    expect(viewerWebSocketUrl("ticket value")).toBe(
      "wss://logs.example.test/ws/viewer?ticket=ticket%20value",
    );
    process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL = "wss://logs.example.test/ws/viewer?trace=1";
    expect(viewerWebSocketUrl("ticket")).toBe(
      "wss://logs.example.test/ws/viewer?trace=1&ticket=ticket",
    );
    if (original === undefined) delete process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
    else process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL = original;
  });

  it("requests a same-origin short-lived viewer ticket", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      expect(input).toBe("/api/v1/auth/viewer-ticket");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Cache-Control": "no-store" },
      });
      return new Response(JSON.stringify({ ticket: "one-time" }), { status: 200 });
    };
    await expect(viewerTicket()).resolves.toBe("one-time");
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await expect(viewerTicket()).rejects.toThrow("viewer ticket unavailable");
    globalThis.fetch = async () => new Response(JSON.stringify({ ticket: null }), { status: 200 });
    await expect(viewerTicket()).resolves.toBeUndefined();
    globalThis.fetch = original;
  });

  it("derives the viewer endpoint from the browser location", () => {
    const original = process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
    const originalWindow = globalThis.window;
    delete process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
    delete (globalThis as { window?: unknown }).window;
    expect(viewerWebSocketUrl()).toBe("ws://127.0.0.1:7421/ws/viewer");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { protocol: "https:", host: "app.example.test" } },
    });
    expect(viewerWebSocketUrl()).toBe("wss://app.example.test/ws/viewer");
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (original === undefined) delete process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
    else process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL = original;
  });
});
