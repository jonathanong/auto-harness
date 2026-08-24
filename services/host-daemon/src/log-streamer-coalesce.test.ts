import { describe, expect, it } from "vitest";

import { LogStreamer } from "./log-streamer.ts";
import { createStreamerClock } from "./log-streamer-test-helpers.ts";
import type { SessionLogChunk } from "@auto-harness/shared";

describe("LogStreamer coalescing", () => {
  it("coalesces consecutive stdout writes until the wait window elapses", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 100, maxMessagesPerSec: 10 },
      clock.timers,
    );
    streamer.write("stdout", "hello ");
    streamer.write("stdout", "world");
    expect(chunks).toEqual([]);
    clock.advance(100);
    expect(chunks).toEqual([
      expect.objectContaining({
        sessionId: "sess-1",
        attemptId: "attempt-1",
        stream: "stdout",
        content: "hello world",
        seq: 0,
      }),
    ]);
    expect(streamer.sortKey(chunks[0]!)).toBe("2026-08-01T12:00:00.000Z#0000000000");
  });

  it("flushes coalesced stdout before a system event and preserves timestampSeq order", () => {
    const chunks: SessionLogChunk[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 100, maxMessagesPerSec: 10 },
    );
    streamer.write("stdout", "out");
    streamer.write("stderr", "err");
    streamer.writeTimestampedSystem("Session completed");
    expect(
      chunks.map((chunk) => ({ stream: chunk.stream, content: chunk.content, seq: chunk.seq })),
    ).toEqual([
      { stream: "stdout", content: "out", seq: 0 },
      { stream: "stderr", content: "err", seq: 1 },
      {
        stream: "system",
        content: "Session completed at 2026-08-01T12:00:00.000Z",
        seq: 2,
      },
    ]);
    expect(streamer.sortKey(chunks[0]!) < streamer.sortKey(chunks[1]!)).toBe(true);
    expect(streamer.sortKey(chunks[1]!) < streamer.sortKey(chunks[2]!)).toBe(true);
  });

  it("enforces the coalesced line bound without exceeding it", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 1_000, logBatchMaxLines: 2, maxMessagesPerSec: 10 },
      clock.timers,
    );
    streamer.write("stdout", "a\n");
    streamer.write("stdout", "b\n");
    streamer.write("stdout", "c\n");
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a\nb\n"]);
    clock.advance(1_000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a\nb\n", "c\n"]);
  });

  it("does not rate-limit when the message cap is unbounded", () => {
    const chunks: string[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk.content),
      undefined,
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 1, maxMessagesPerSec: Number.POSITIVE_INFINITY },
    );
    streamer.write("stdout", "abc");
    expect(chunks).toEqual(["a", "b", "c"]);
    streamer.flush();
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("does not grow a pending batch past the session byte budget", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      undefined,
      0,
      { logBatchMaxWaitMs: 100, maxBytes: 1, maxMessagesPerSec: 10 },
      clock.timers,
    );
    streamer.write("stdout", "a");
    expect(streamer.write("stdout", "b")).toBeNull();
    streamer.flush();
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a"]);
  });

  it("uses documented rate defaults until flush", () => {
    const chunks: SessionLogChunk[] = [];
    const streamer = new LogStreamer("sess-1", "attempt-1", (chunk) => chunks.push(chunk));
    streamer.write("stdout", "buffered");
    expect(chunks).toEqual([]);
    streamer.flush();
    expect(chunks).toEqual([
      expect.objectContaining({ sessionId: "sess-1", attemptId: "attempt-1", content: "buffered" }),
    ]);
  });

  it("clears a coalescing timer on flush so later status is not blocked", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 100, maxMessagesPerSec: 10 },
      clock.timers,
    );
    streamer.write("stdout", "kept");
    streamer.flush();
    expect(chunks.map((chunk) => chunk.content)).toEqual(["kept"]);
    clock.advance(100);
    expect(chunks).toHaveLength(1);
  });
});
