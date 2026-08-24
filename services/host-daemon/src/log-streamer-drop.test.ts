import { describe, expect, it } from "vitest";

import type { SessionLogChunk } from "@auto-harness/shared";

import { formatDroppedLogNotice } from "./log-coalesce.ts";
import { LogStreamer, type LogLimits } from "./log-streamer.ts";
import { createStreamerClock, type StreamerClock } from "./log-streamer-test-helpers.ts";

function createDropStreamer(chunks: SessionLogChunk[], limits: LogLimits, clock?: StreamerClock) {
  return new LogStreamer(
    "sess-1",
    "attempt-1",
    (chunk) => chunks.push(chunk),
    () => "2026-08-01T12:00:00.000Z",
    0,
    limits,
    clock?.timers,
  );
}

function contents(chunks: SessionLogChunk[]) {
  return chunks.map((chunk) => ({ content: chunk.content, dropped: chunk.dropped }));
}

const tight = { logBatchMaxWaitMs: 0, maxWireBytes: 1, maxMessagesPerSec: 1 };

describe("LogStreamer drop telemetry", () => {
  it("enforces the coalesced byte bound and rate-limit drop counter", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = createDropStreamer(chunks, tight, clock);
    expect(streamer.write("stdout", "a")?.content).toBe("a");
    streamer.write("stdout", "b");
    streamer.write("stdout", "c");
    streamer.write("stdout", "d");
    streamer.write("stdout", "e");
    expect(streamer.droppedCount()).toBe(2);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a"]);
    streamer.flush();
    expect(contents(chunks)).toEqual([
      { content: "a", dropped: undefined },
      { content: "b", dropped: undefined },
      { content: "c", dropped: undefined },
      { content: formatDroppedLogNotice(2), dropped: 2 },
    ]);
    expect(chunks[3]).toEqual(
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
    const streamer = createDropStreamer(chunks, tight, clock);
    streamer.write("stdout", "a");
    streamer.write("stdout", "b");
    streamer.write("stdout", "c");
    streamer.write("stdout", "d");
    clock.advance(1_000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a", "b"]);
    clock.advance(1_000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a", "b", "c"]);
    clock.advance(1_000);
    expect(contents(chunks)).toEqual([
      { content: "a", dropped: undefined },
      { content: "b", dropped: undefined },
      { content: "c", dropped: undefined },
      { content: formatDroppedLogNotice(1), dropped: 1 },
    ]);
  });

  it("still emits drop telemetry when the session chunk cap is already full", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = createDropStreamer(chunks, { ...tight, maxChunks: 2 }, clock);
    streamer.write("stdout", "a");
    streamer.write("stdout", "b");
    streamer.write("stdout", "c");
    clock.advance(1_000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a", "b"]);
    clock.advance(1_000);
    expect(streamer.droppedCount()).toBe(1);
    expect(contents(chunks)).toEqual([
      { content: "a", dropped: undefined },
      { content: "b", dropped: undefined },
      { content: formatDroppedLogNotice(1), dropped: 1 },
    ]);
    clock.advance(1_000);
    expect(chunks).toHaveLength(3);
  });

  it("still emits system lifecycle lines after session chunk and byte caps fill", () => {
    const byChunks: SessionLogChunk[] = [];
    const chunkStreamer = createDropStreamer(byChunks, {
      logBatchMaxWaitMs: 0,
      maxMessagesPerSec: 10,
      maxChunks: 1,
    });
    expect(chunkStreamer.write("stdout", "a")?.content).toBe("a");
    expect(chunkStreamer.write("stdout", "b")).toBeNull();
    expect(chunkStreamer.write("system", "Process execution failed.")?.content).toBe(
      "Process execution failed.",
    );
    expect(chunkStreamer.writeTimestampedSystem("Session failed")?.content).toBe(
      "Session failed at 2026-08-01T12:00:00.000Z",
    );
    expect(byChunks.map((chunk) => chunk.content)).toEqual([
      "a",
      "Process execution failed.",
      "Session failed at 2026-08-01T12:00:00.000Z",
    ]);
    const byBytes: SessionLogChunk[] = [];
    const byteStreamer = createDropStreamer(byBytes, {
      logBatchMaxWaitMs: 0,
      maxMessagesPerSec: 10,
      maxBytes: 1,
    });
    expect(byteStreamer.write("stdout", "a")?.content).toBe("a");
    expect(byteStreamer.write("stdout", "b")).toBeNull();
    expect(byteStreamer.write("system", "failed")?.content).toBe("failed");
    expect(byBytes.map((chunk) => chunk.content)).toEqual(["a", "failed"]);
  });

  it("caps each drop notice at the wire limit and retains the remainder", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = createDropStreamer(chunks, { ...tight, maxDroppedPerNotice: 2 }, clock);
    for (const piece of ["a", "b", "c", "d", "e", "f"]) streamer.write("stdout", piece);
    expect(streamer.droppedCount()).toBe(3);
    streamer.flush();
    expect(contents(chunks)).toEqual([
      { content: "a", dropped: undefined },
      { content: "b", dropped: undefined },
      { content: "c", dropped: undefined },
      { content: formatDroppedLogNotice(2), dropped: 2 },
      { content: formatDroppedLogNotice(1), dropped: 1 },
    ]);
    for (const chunk of chunks) {
      expect(chunk.dropped ?? 0).toBeLessThanOrEqual(2);
    }
  });
});
