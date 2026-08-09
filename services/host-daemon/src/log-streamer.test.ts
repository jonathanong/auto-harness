import { describe, expect, it } from "vitest";

import { LogStreamer } from "./log-streamer.ts";

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

  it("caps total retained chunks and UTF-8 bytes", () => {
    const chunks: string[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      (chunk) => chunks.push(chunk.content),
      undefined,
      0,
      { maxChunks: 2, maxBytes: 5 },
    );
    streamer.write("stdout", "ééé");
    streamer.write("stdout", "x");
    expect(streamer.write("stdout", "y")).toBeNull();
    expect(chunks).toEqual(["éé", "x"]);
    expect(Buffer.byteLength(chunks.join(""), "utf8")).toBe(5);
  });

  it("drops a character that cannot fit into the remaining byte budget", () => {
    const streamer = new LogStreamer("sess-1", () => undefined, undefined, 0, { maxBytes: 1 });
    expect(streamer.write("stdout", "é")).toBeNull();
  });
});
