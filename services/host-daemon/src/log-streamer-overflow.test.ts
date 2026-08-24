import { describe, expect, it } from "vitest";

import type { SessionLogChunk } from "@auto-harness/shared";

import { LogStreamer } from "./log-streamer.ts";
import { createStreamerClock } from "./log-streamer-test-helpers.ts";

describe("LogStreamer overflow and split writes", () => {
  it("parks a stream change instead of dropping it while rate-limited", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 10, maxMessagesPerSec: 1 },
      clock.timers,
    );
    streamer.write("stdout", "out");
    streamer.write("stdout", "more");
    streamer.write("stderr", "err");
    expect(streamer.droppedCount()).toBe(0);
    streamer.flush();
    expect(chunks.map((chunk) => ({ stream: chunk.stream, content: chunk.content }))).toEqual([
      { stream: "stdout", content: "out" },
      { stream: "stdout", content: "more" },
      { stream: "stderr", content: "err" },
    ]);
  });

  it("does not append a split write's suffix onto the batch that rejected its prefix", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 5, maxMessagesPerSec: 1 },
      clock.timers,
    );
    streamer.write("stdout", "1234");
    streamer.write("stdout", "xx");
    streamer.write("stdout", "ABCDEFGHIJ");
    expect(streamer.droppedCount()).toBe(1);
    streamer.flush();
    expect(
      chunks.filter((chunk) => chunk.stream !== "system").map((chunk) => chunk.content),
    ).toEqual(["1234", "xx", "ABCDE"]);
    expect(chunks.some((chunk) => chunk.content.includes("FGHIJ"))).toBe(false);
    expect(chunks.some((chunk) => chunk.content === "xxFGHIJ")).toBe(false);
  });

  it("splits a single write on the line bound", () => {
    const chunks: SessionLogChunk[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      undefined,
      0,
      { logBatchMaxWaitMs: 0, logBatchMaxLines: 2, maxMessagesPerSec: 10 },
    );
    streamer.write("stdout", "a\nb\nc\n");
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a\nb\n", "c\n"]);
  });

  it("appends further same-stream writes onto the parked overflow batch", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 10, maxMessagesPerSec: 1 },
      clock.timers,
    );
    streamer.write("stdout", "out");
    streamer.write("stdout", "more");
    streamer.write("stderr", "e");
    streamer.write("stderr", "rr");
    expect(streamer.droppedCount()).toBe(0);
    streamer.flush();
    expect(chunks.map((chunk) => ({ stream: chunk.stream, content: chunk.content }))).toEqual([
      { stream: "stdout", content: "out" },
      { stream: "stdout", content: "more" },
      { stream: "stderr", content: "err" },
    ]);
  });

  it("does not append later stdout onto pending once overflow holds an intervening write", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 10, maxMessagesPerSec: 1 },
      clock.timers,
    );
    streamer.write("stdout", "b");
    streamer.write("stdout", "more");
    streamer.write("stderr", "c");
    streamer.write("stdout", "d");
    expect(streamer.droppedCount()).toBe(1);
    streamer.flush();
    expect(
      chunks
        .filter((chunk) => chunk.stream !== "system")
        .map((chunk) => ({
          stream: chunk.stream,
          content: chunk.content,
        })),
    ).toEqual([
      { stream: "stdout", content: "b" },
      { stream: "stdout", content: "more" },
      { stream: "stderr", content: "c" },
    ]);
    expect(chunks.some((chunk) => chunk.content.includes("mored"))).toBe(false);
  });

  it("schedules leftover drop telemetry after emitting one capped notice", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 0, maxWireBytes: 1, maxMessagesPerSec: 1, maxDroppedPerNotice: 2 },
      clock.timers,
    );
    for (const piece of ["a", "b", "c", "d", "e", "f"]) streamer.write("stdout", piece);
    clock.advance(1_000);
    clock.advance(1_000);
    expect(
      chunks.filter((chunk) => chunk.dropped !== undefined).map((chunk) => chunk.dropped),
    ).toEqual([2]);
    clock.advance(1_000);
    expect(
      chunks.filter((chunk) => chunk.dropped !== undefined).map((chunk) => chunk.dropped),
    ).toEqual([2, 1]);
  });

  it("flushes an already-full batch as soon as the rate window allows", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { logBatchMaxWaitMs: 100, maxWireBytes: 2, maxMessagesPerSec: 10 },
      clock.timers,
    );
    streamer.write("stdout", "ab");
    expect(chunks.map((chunk) => chunk.content)).toEqual(["ab"]);
  });
});
