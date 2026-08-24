import { describe, expect, it } from "vitest";

import { formatDroppedLogNotice } from "./log-coalesce.ts";
import { LogStreamer } from "./log-streamer.ts";
import { createStreamerClock } from "./log-streamer-test-helpers.ts";
import type { SessionLogChunk } from "@auto-harness/shared";

describe("LogStreamer drop telemetry", () => {
  it("enforces the coalesced byte bound and rate-limit drop counter", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 1, maxMessagesPerSec: 1 },
      clock.timers,
    );
    expect(streamer.write("stdout", "a")?.content).toBe("a");
    streamer.write("stdout", "b");
    streamer.write("stdout", "c");
    streamer.write("stdout", "d");
    expect(streamer.droppedCount()).toBe(2);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a"]);
    streamer.flush();
    expect(chunks.map((chunk) => ({ content: chunk.content, dropped: chunk.dropped }))).toEqual([
      { content: "a", dropped: undefined },
      { content: "b", dropped: undefined },
      { content: formatDroppedLogNotice(2), dropped: 2 },
    ]);
    expect(chunks[2]).toEqual(
      expect.objectContaining({
        sessionId: "sess-1",
        attemptId: "attempt-1",
        stream: "system",
        dropped: 2,
      }),
    );
  });

  it("does not count session-budget exhaustion as drop telemetry", () => {
    const streamer = new LogStreamer("sess-1", "attempt-1", () => undefined, undefined, 0, {
      logBatchMaxWaitMs: 0,
      maxMessagesPerSec: 10,
      maxChunks: 1,
    });
    streamer.write("stdout", "a");
    expect(streamer.write("stdout", "b")).toBeNull();
    expect(streamer.droppedCount()).toBe(0);
  });

  it("emits a delayed drop notice once the rate window reopens", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 1, maxMessagesPerSec: 1 },
      clock.timers,
    );
    streamer.write("stdout", "a");
    streamer.write("stdout", "b");
    streamer.write("stdout", "c");
    clock.advance(1_000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a", "b"]);
    clock.advance(1_000);
    expect(chunks.map((chunk) => ({ content: chunk.content, dropped: chunk.dropped }))).toEqual([
      { content: "a", dropped: undefined },
      { content: "b", dropped: undefined },
      { content: formatDroppedLogNotice(1), dropped: 1 },
    ]);
  });

  it("still emits drop telemetry when the session chunk cap is already full", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 1, maxMessagesPerSec: 1, maxChunks: 2 },
      clock.timers,
    );
    streamer.write("stdout", "a");
    streamer.write("stdout", "b");
    streamer.write("stdout", "c");
    clock.advance(1_000);
    clock.advance(1_000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a", "b"]);
    streamer.flush();
    expect(streamer.droppedCount()).toBe(1);
    expect(chunks.map((chunk) => ({ content: chunk.content, dropped: chunk.dropped }))).toEqual([
      { content: "a", dropped: undefined },
      { content: "b", dropped: undefined },
      { content: formatDroppedLogNotice(1), dropped: 1 },
    ]);
  });
});
