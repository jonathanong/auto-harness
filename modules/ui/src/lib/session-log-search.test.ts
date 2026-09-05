import { describe, expect, it } from "vitest";

import { parseSessionLogText } from "./session-log-records.ts";
import {
  findRecordMatches,
  findTextMatches,
  markSearchText,
  nextMatchIndex,
  searchResultLabel,
} from "./session-log-search.ts";

describe("session log search", () => {
  it("finds case-insensitive matches and labels results", () => {
    expect(findTextMatches("abc", "")).toEqual([]);
    expect(findTextMatches("AbAb", "ab")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findTextMatches("zzz", "ab")).toEqual([]);
    const records = parseSessionLogText("hello\nHELLO world");
    expect(findRecordMatches(records, "hello", false)).toEqual([
      { line: 1, start: 0, end: 5 },
      { line: 2, start: 0, end: 5 },
    ]);
    expect(searchResultLabel(0, 0, false)).toBe("");
    expect(searchResultLabel(0, 0, true)).toBe("No match");
    expect(searchResultLabel(3, 1, true)).toBe("2 of 3");
  });

  it("cycles match indexes and marks active spans", () => {
    expect(nextMatchIndex(0, 0, "next")).toBe(0);
    expect(nextMatchIndex(3, -1, "next")).toBe(0);
    expect(nextMatchIndex(3, -1, "previous")).toBe(2);
    expect(nextMatchIndex(3, 2, "next")).toBe(0);
    expect(nextMatchIndex(3, 0, "previous")).toBe(2);
    expect(markSearchText("abc", "z")).toEqual([{ text: "abc", kind: "plain" }]);
    expect(markSearchText("abXab", "ab", 3)).toEqual([
      { text: "ab", kind: "match" },
      { text: "X", kind: "plain" },
      { text: "ab", kind: "active" },
    ]);
    expect(markSearchText("abZ", "ab")).toEqual([
      { text: "ab", kind: "match" },
      { text: "Z", kind: "plain" },
    ]);
  });
});
