import { describe, expect, it } from "vitest";

import {
  appendToBatch,
  batchAtBound,
  canAppendToBatch,
  countLogLines,
  DEFAULT_LOG_BATCH_MAX_LINES,
  DEFAULT_LOG_BATCH_MAX_WAIT_MS,
  DEFAULT_LOG_MESSAGES_PER_SEC,
  formatDroppedLogNotice,
  LogRateWindow,
  splitLogLines,
  splitUtf8,
  startBatch,
  truncateUtf8,
  type CoalesceBatch,
} from "./log-coalesce.ts";

const batch = (content: string, stream: CoalesceBatch["stream"] = "stdout"): CoalesceBatch => ({
  stream,
  content,
  timestamp: "t",
  bytes: Buffer.byteLength(content, "utf8"),
});

describe("log coalescing helpers", () => {
  it("exports the documented ~10 msg/s batch defaults", () => {
    expect(DEFAULT_LOG_MESSAGES_PER_SEC).toBe(10);
    expect(DEFAULT_LOG_BATCH_MAX_WAIT_MS).toBe(100);
    expect(DEFAULT_LOG_BATCH_MAX_LINES).toBe(100);
  });

  it("counts newline-delimited lines including a trailing partial line", () => {
    expect(countLogLines("")).toBe(0);
    expect(countLogLines("a")).toBe(1);
    expect(countLogLines("a\n")).toBe(1);
    expect(countLogLines("a\nb")).toBe(2);
    expect(countLogLines("a\nb\n")).toBe(2);
  });

  it("formats drop telemetry for the control plane to alarm on", () => {
    expect(formatDroppedLogNotice(3)).toBe("3 log chunk(s) dropped");
  });

  it("rejects appends that change stream or exceed byte/line bounds", () => {
    expect(canAppendToBatch(batch("a\n"), "stderr", "b\n", 2, 100, 10)).toBe(false);
    expect(canAppendToBatch(batch("abcd"), "stdout", "e", 1, 4, 10)).toBe(false);
    expect(canAppendToBatch(batch("a\n"), "stdout", "b\n", 2, 100, 1)).toBe(false);
    expect(canAppendToBatch(batch("a\n"), "stdout", "b\n", 2, 100, 2)).toBe(true);
  });

  it("detects a batch that cannot grow and splits writes on the line bound", () => {
    expect(batchAtBound(batch("a\nb\n"), 100, 2)).toBe(true);
    expect(batchAtBound(batch("ab"), 2, 10)).toBe(true);
    expect(batchAtBound(batch("a"), 100, 10)).toBe(false);
    expect(splitLogLines("", 2)).toEqual([]);
    expect(splitLogLines("a\nb\n", 2)).toEqual(["a\nb\n"]);
    expect(splitLogLines("a\nb\nc\n", 2)).toEqual(["a\nb\n", "c\n"]);
    expect(splitLogLines("a\nb\nc", 2)).toEqual(["a\nb\n", "c"]);
  });

  it("truncates and splits on UTF-8 character boundaries", () => {
    expect(truncateUtf8("abc", 10)).toBe("abc");
    expect(truncateUtf8("éé", 2)).toBe("é");
    expect(splitUtf8("", 4)).toEqual([]);
    expect(splitUtf8("é", 1)).toEqual(["é"]);
    expect(splitUtf8("ééé", 4)).toEqual(["éé", "é"]);
  });

  it("mutates a coalesced batch in place", () => {
    const pending = startBatch("stdout", "ab", "t");
    appendToBatch(pending, "c");
    expect(pending).toEqual({ stream: "stdout", content: "abc", timestamp: "t", bytes: 3 });
  });

  it("opens the rate window after a full second", () => {
    let nowMs = 0;
    const window = new LogRateWindow(1, () => nowMs);
    expect(window.canEmit()).toBe(true);
    expect(window.nextEmitAt(0)).toBe(0);
    window.record();
    expect(window.canEmit()).toBe(false);
    expect(window.nextEmitAt(0)).toBe(1_000);
    nowMs = 1_000;
    expect(window.canEmit()).toBe(true);
    const unbounded = new LogRateWindow(Number.POSITIVE_INFINITY, () => 0);
    unbounded.record();
    expect(unbounded.canEmit()).toBe(true);
    expect(unbounded.nextEmitAt(5)).toBe(5);
  });
});
