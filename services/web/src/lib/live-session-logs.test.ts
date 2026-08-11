import { describe, expect, it } from "vitest";

import {
  lastLiveCursor,
  mergeInitialLiveLogs,
  mergeLiveLogs,
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

describe("live session log state", () => {
  it("orders history, deduplicates reconnect replay, and bounds retained output", () => {
    const second = { ...first, timestampSeq: "2026-08-10T12:00:01.000Z#0000000002", seq: 2 };
    const third = { ...first, timestampSeq: "2026-08-10T12:00:02.000Z#0000000003", seq: 3 };
    let entries = mergeInitialLiveLogs([second, first, second]);
    entries = mergeLiveLogs(entries, third, 2);

    expect(entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(lastLiveCursor(entries)).toBe(third.timestampSeq);
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
      expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
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
