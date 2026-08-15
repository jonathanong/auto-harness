import { describe, expect, it } from "vitest";

import {
  adjustedTerminalFontSize,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  terminalDownloadName,
  terminalShortcut,
  terminalText,
} from "./session-terminal.ts";

describe("session terminal helpers", () => {
  it("sorts cursor chunks while preserving ANSI and exact newlines", () => {
    expect(
      terminalText([
        {
          timestampSeq: "b",
          seq: 2,
          stream: "stdout",
          content: "done\n",
          timestamp: "later",
        },
        {
          timestampSeq: "a",
          seq: 1,
          stream: "stdout",
          content: "\u001b[31mred\u001b[0m\rprogress",
          timestamp: "first",
        },
      ]),
    ).toBe("\u001b[31mred\u001b[0m\rprogressdone\n");
  });

  it("labels and line-terminates system events without changing stdout", () => {
    expect(
      terminalText([
        {
          timestampSeq: "a",
          seq: 1,
          stream: "system",
          content: "Session started at 2026-08-01T12:00:05.000Z",
          timestamp: "2026-08-01T12:00:05.000Z",
        },
        {
          timestampSeq: "b",
          seq: 2,
          stream: "stdout",
          content: "exact stdout\n",
          timestamp: "2026-08-01T12:00:06.000Z",
        },
        {
          timestampSeq: "c",
          seq: 3,
          stream: "system",
          content: "Session completed\n",
          timestamp: "2026-08-01T12:00:07.000Z",
        },
      ]),
    ).toBe(
      "[system] Session started at 2026-08-01T12:00:05.000Z\r\n" +
        "exact stdout\n" +
        "[system] Session completed\r\n",
    );
  });

  it("clamps font size and sanitizes download names", () => {
    expect(adjustedTerminalFontSize(13, 1)).toBe(14);
    expect(adjustedTerminalFontSize(MAX_TERMINAL_FONT_SIZE, 1)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(adjustedTerminalFontSize(MIN_TERMINAL_FONT_SIZE, -1)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(terminalDownloadName("session/one two")).toBe("session-one-two.txt");
    expect(terminalDownloadName("///")).toBe("---.txt");
    expect(terminalDownloadName("")).toBe("session.txt");
  });

  it("maps cross-platform terminal shortcuts", () => {
    expect(terminalShortcut({ ctrlKey: false, metaKey: false, key: "f" })).toBeNull();
    expect(terminalShortcut({ ctrlKey: true, metaKey: false, key: "F" })).toBe("search");
    expect(terminalShortcut({ ctrlKey: false, metaKey: true, key: "+" })).toBe("font-increase");
    expect(terminalShortcut({ ctrlKey: true, metaKey: false, key: "=" })).toBe("font-increase");
    expect(terminalShortcut({ ctrlKey: true, metaKey: false, key: "-" })).toBe("font-decrease");
    expect(terminalShortcut({ ctrlKey: true, metaKey: false, key: "0" })).toBeNull();
  });
});
