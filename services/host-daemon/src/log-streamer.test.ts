import { describe, expect, it } from "vitest";

import { LogStreamer } from "./log-streamer.ts";

describe("LogStreamer", () => {
  it("assigns monotonic seq for same timestamp", () => {
    const chunks: { seq: number; sk: string }[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
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

  it("uses one timestamp for a timestamped system event's content and cursor", () => {
    const chunks = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk),
      () => "2026-08-01T12:00:05.000Z",
    );
    streamer.writeTimestampedSystem("Session started");
    expect(chunks).toEqual([
      expect.objectContaining({
        stream: "system",
        content: "Session started at 2026-08-01T12:00:05.000Z",
        timestamp: "2026-08-01T12:00:05.000Z",
      }),
    ]);
  });

  it("caps total retained chunks and UTF-8 bytes", () => {
    const chunks: string[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
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
    const streamer = new LogStreamer("sess-1", "attempt-1", () => undefined, undefined, 0, {
      maxBytes: 1,
    });
    expect(streamer.write("stdout", "é")).toBeNull();
  });

  it("counts chunks independently from a continued sequence", () => {
    const chunks: number[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk.seq),
      undefined,
      10_000,
      { maxChunks: 2 },
    );
    streamer.write("stdout", "a");
    streamer.write("stdout", "b");
    expect(streamer.write("stdout", "c")).toBeNull();
    expect(chunks).toEqual([10_000, 10_001]);
  });

  it("splits a single write exceeding the wire limit into sequential chunks", () => {
    const chunks: { content: string; seq: number }[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push({ content: chunk.content, seq: chunk.seq }),
      () => "2026-08-01T12:00:00.000Z",
      0,
      { maxWireBytes: 10 },
    );
    const last = streamer.write("stdout", "abcdefghijklmnopqrstuvwxyz");
    // 26 bytes split into 10-byte pieces: three full pieces of 10 plus a final 6.
    expect(chunks.map((c) => c.content)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.content).join("")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(last).toEqual(expect.objectContaining({ content: "uvwxyz", seq: 2 }));
    expect(streamer.nextSeq()).toBe(3);
  });

  it("keeps multi-byte characters intact across a wire-size split boundary", () => {
    const chunks: string[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk.content),
      undefined,
      0,
      { maxWireBytes: 5 },
    );
    // "éé" is 4 bytes (2 each); "é" landing 5th would overflow a 5-byte piece, so it must
    // start a new piece rather than being split mid-character.
    streamer.write("stdout", "ééé");
    expect(chunks).toEqual(["éé", "é"]);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(5);
    }
  });

  it("stops splitting once maxChunks is exhausted mid-write, without exceeding it", () => {
    const chunks: string[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk.content),
      undefined,
      0,
      { maxWireBytes: 1, maxChunks: 2 },
    );
    const last = streamer.write("stdout", "abcd");
    expect(chunks).toEqual(["a", "b"]);
    expect(last).toEqual(expect.objectContaining({ content: "b", seq: 1 }));
  });

  it("respects the overall per-session byte budget across a split write", () => {
    const chunks: string[] = [];
    const streamer = new LogStreamer(
      "sess-1",
      "attempt-1",
      (chunk) => chunks.push(chunk.content),
      undefined,
      0,
      { maxWireBytes: 3, maxBytes: 7 },
    );
    const last = streamer.write("stdout", "abcdefghij");
    // The 10-char write is first bounded to the 7-byte session budget ("abcdefg"), then that
    // is split into 3-byte wire pieces.
    expect(chunks).toEqual(["abc", "def", "g"]);
    expect(Buffer.byteLength(chunks.join(""), "utf8")).toBe(7);
    expect(last).toEqual(expect.objectContaining({ content: "g" }));
  });

  it("keeps the default wire budget under API Gateway's 32 KB per-frame limit even for worst-case JSON-escaped content", () => {
    const chunks: string[] = [];
    const streamer = new LogStreamer("sess-1", "attempt-1", (chunk) => chunks.push(chunk.content));
    // Every char here JSON-escapes to a six-byte \u00XX sequence — the adversarial case
    // the default budget is sized against, not typical CLI/terminal output.
    const controlByte = String.fromCharCode(1);
    streamer.write("stdout", controlByte.repeat(200_000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const content of chunks) {
      const envelope = {
        type: "session:log",
        sessionId: "sess-1",
        attemptId: "attempt-1",
        stream: "stdout",
        content,
        timestamp: "2026-08-01T12:00:00.000Z",
        seq: 0,
      };
      // API Gateway closes the connection with code 1009 above this per-frame limit, and
      // the `ws` client sends every outbound payload as exactly one frame (see
      // ws-transport.ts / ws-wire.ts) — so the serialized message, not just the raw
      // content, must stay under it.
      expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThan(32 * 1024);
    }
  });
});
