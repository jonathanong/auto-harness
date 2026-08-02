import { describe, expect, it } from "vitest";

import { LogStreamer } from "./log-streamer.js";

describe("LogStreamer", () => {
  it("assigns monotonic seq for same timestamp", () => {
    const chunks: { seq: number; sk: string }[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      (c) => {
        chunks.push({ seq: c.seq, sk: streamer.sortKey(c) });
      },
      () => "2026-08-01T12:00:00.000Z",
    );
    streamer.write("stdout", "a");
    streamer.write("stdout", "b");
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(chunks[0]!.sk < chunks[1]!.sk).toBe(true);
    expect(streamer.nextSeq()).toBe(2);
  });
});
