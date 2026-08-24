import { describe, expect, it } from "vitest";

import type { SessionLogChunk } from "@auto-harness/shared";

import { LogStreamer, type LogLimits } from "./log-streamer.ts";
import { createStreamerClock, type StreamerClock } from "./log-streamer-test-helpers.ts";

function createOverflowStreamer(
  chunks: SessionLogChunk[],
  limits: LogLimits,
  clock?: StreamerClock,
) {
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

const rateLimited = { logBatchMaxWaitMs: 0, maxWireBytes: 10, maxMessagesPerSec: 1 };

describe("LogStreamer overflow and split writes", () => {
  it("parks a stream change instead of dropping it while rate-limited", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = createOverflowStreamer(chunks, rateLimited, clock);
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
    const streamer = createOverflowStreamer(
      chunks,
      { logBatchMaxWaitMs: 0, maxWireBytes: 5, maxMessagesPerSec: 1 },
      clock,
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
    const streamer = createOverflowStreamer(chunks, {
      logBatchMaxWaitMs: 0,
      logBatchMaxLines: 2,
      maxMessagesPerSec: 10,
    });
    streamer.write("stdout", "a\nb\nc\n");
    expect(chunks.map((chunk) => chunk.content)).toEqual(["a\nb\n", "c\n"]);
  });

  it("appends further same-stream writes onto the parked overflow batch", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = createOverflowStreamer(chunks, rateLimited, clock);
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
    const streamer = createOverflowStreamer(chunks, rateLimited, clock);
    streamer.write("stdout", "b");
    streamer.write("stdout", "more");
    streamer.write("stderr", "c");
    streamer.write("stdout", "d");
    streamer.write("stderr", "e");
    expect(streamer.droppedCount()).toBe(2);
    expect(chunks.some((chunk) => chunk.content.includes("mored"))).toBe(false);
    clock.advance(1_000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(["b", "more"]);
    clock.advance(1_000);
    expect(chunks.map((chunk) => ({ stream: chunk.stream, content: chunk.content }))).toEqual([
      { stream: "stdout", content: "b" },
      { stream: "stdout", content: "more" },
      { stream: "stderr", content: "c" },
    ]);
    clock.advance(1_000);
    expect(chunks.at(-1)).toEqual(expect.objectContaining({ stream: "system", dropped: 2 }));
    expect(chunks.some((chunk) => chunk.content === "ce")).toBe(false);
  });

  it("coalesces onto a just-promoted overflow batch when the rate window reopens", () => {
    const chunks: SessionLogChunk[] = [];
    let nowMs = 0;
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:00.000Z",
      0,
      rateLimited,
      {
        nowMs: () => nowMs,
        setTimeout: () => 1 as ReturnType<typeof setTimeout>,
        clearTimeout: () => undefined,
      },
    );
    streamer.write("stdout", "out");
    streamer.write("stdout", "ab");
    streamer.write("stderr", "xy");
    nowMs = 1_000;
    streamer.write("stderr", "z");
    streamer.flush();
    expect(chunks.map((chunk) => ({ stream: chunk.stream, content: chunk.content }))).toEqual([
      { stream: "stdout", content: "out" },
      { stream: "stdout", content: "ab" },
      { stream: "stderr", content: "xyz" },
    ]);
  });

  it("drops remaining pieces after a split prefix is rejected", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = createOverflowStreamer(
      chunks,
      { logBatchMaxWaitMs: 0, maxWireBytes: 5, maxMessagesPerSec: 1 },
      clock,
    );
    streamer.write("stdout", "out");
    streamer.write("stdout", "more");
    streamer.write("stderr", "e");
    streamer.write("stderr", "123456");
    streamer.flush();
    const stderr = chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.content);
    expect(stderr.some((content) => content.includes("6"))).toBe(false);
    expect(stderr.join("")).not.toContain("12345");
  });

  it("schedules leftover drop telemetry after emitting one capped notice", () => {
    const chunks: SessionLogChunk[] = [];
    const clock = createStreamerClock();
    const streamer = createOverflowStreamer(
      chunks,
      { logBatchMaxWaitMs: 0, maxWireBytes: 1, maxMessagesPerSec: 1, maxDroppedPerNotice: 2 },
      clock,
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
    const streamer = createOverflowStreamer(
      chunks,
      { logBatchMaxWaitMs: 100, maxWireBytes: 2, maxMessagesPerSec: 10 },
      clock,
    );
    streamer.write("stdout", "ab");
    expect(chunks.map((chunk) => chunk.content)).toEqual(["ab"]);
  });
});
