import { describe, expect, it } from "vitest";

import { ansiSpans, stripAnsi } from "./session-log-ansi.ts";

describe("session log ANSI", () => {
  it("strips CSI, OSC, and lone escapes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(stripAnsi("\u001b]0;title\u0007plain")).toBe("plain");
    expect(stripAnsi("\u001b[2Kleft")).toBe("left");
    expect(stripAnsi('\u001b[?25l{"type":"result"}')).toBe('{"type":"result"}');
    expect(stripAnsi("plain")).toBe("plain");
  });

  it("parses colors, bold, reset, and defaults", () => {
    expect(ansiSpans("")).toEqual([]);
    expect(ansiSpans("plain")).toEqual([{ text: "plain" }]);
    expect(ansiSpans("\u001b[31mred")).toEqual([{ text: "red", color: "#f87171" }]);
    expect(ansiSpans("\u001b[1;32mgo\u001b[0m.")).toEqual([
      { text: "go", color: "#4ade80", bold: true },
      { text: "." },
    ]);
    expect(ansiSpans("\u001b[m\u001b[22m\u001b[39m\u001b[49mx")).toEqual([{ text: "x" }]);
    expect(ansiSpans("\u001b[1mbold\u001b[22mplain")).toEqual([
      { text: "bold", bold: true },
      { text: "plain" },
    ]);
    expect(ansiSpans("\u001b[41m\u001b[37mhi")).toEqual([
      { text: "hi", color: "#e5e7eb", background: "#7f1d1d" },
    ]);
    expect(ansiSpans("\u001b[90m\u001b[42mdim")).toEqual([
      { text: "dim", color: "#9ca3af", background: "#14532d" },
    ]);
    expect(ansiSpans("\u001b[99munknown")).toEqual([{ text: "unknown" }]);
    expect(ansiSpans("\u001b[1m\u001b[Kkeep")).toEqual([{ text: "keep", bold: true }]);
  });
});
