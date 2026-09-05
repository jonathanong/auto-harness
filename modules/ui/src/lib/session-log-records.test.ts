import { describe, expect, it } from "vitest";

import {
  droppedPrefixLineCount,
  foldCarriageReturnLine,
  parseSessionLogText,
  prettyJson,
  presentCategories,
  recordDisplayText,
  shouldCollapse,
  splitLogText,
  toggleSetValue,
  truncateDisplay,
  visibleRecords,
} from "./session-log-records.ts";

describe("session log records", () => {
  it("splits lines and folds carriage returns", () => {
    expect(splitLogText("")).toEqual([]);
    expect(splitLogText("a\r\nb\n")).toEqual(["a", "b"]);
    expect(foldCarriageReturnLine("plain")).toBe("plain");
    expect(foldCarriageReturnLine("aa\rbbb")).toBe("bbb");
    expect(foldCarriageReturnLine("abcd\rxy")).toBe("xycd");
    expect(foldCarriageReturnLine("\u001b[31mabc\rde")).toBe("dec");
    expect(droppedPrefixLineCount("", "a\n")).toBe(0);
    expect(droppedPrefixLineCount("keep\n", "keep\nmore\n")).toBe(0);
    expect(droppedPrefixLineCount("gone\nkeep\n", "keep\n")).toBe(1);
    expect(droppedPrefixLineCount("one\ntwo\n", "two\nthree\n")).toBe(1);
    expect(droppedPrefixLineCount("alpha", "beta")).toBe(0);
    expect(parseSessionLogText("only\n", 4).map((record) => record.line)).toEqual([5]);
  });

  it("numbers records and pretty-prints JSONL", () => {
    const records = parseSessionLogText(
      "[system] hi\r\n" + JSON.stringify({ type: "turn.started" }) + "\nstdout",
    );
    expect(records.map((record) => record.category)).toEqual(["system", "event", "output"]);
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(recordDisplayText(records[1]!, true)).toContain('"type": "turn.started"');
    expect(recordDisplayText(records[1]!, false)).toBe("turn.started");
    expect(recordDisplayText(records[2]!, false)).toBe("stdout");
    const emptyPreview = {
      line: 1,
      raw: "raw",
      category: "output" as const,
      typeLabel: "output",
      preview: "",
      json: undefined,
    };
    expect(recordDisplayText(emptyPreview, false)).toBe("raw");
  });

  it("collapses long bodies and filters categories", () => {
    expect(shouldCollapse("short")).toBe(false);
    expect(shouldCollapse("n".repeat(501))).toBe(true);
    expect(shouldCollapse(Array.from({ length: 9 }, () => "x").join("\n"))).toBe(true);
    expect(truncateDisplay("n".repeat(501)).length).toBe(500);
    expect(truncateDisplay("a\nb\nc")).toBe("a\nb\nc");
    expect(truncateDisplay(Array.from({ length: 10 }, (_, i) => String(i)).join("\n"))).toBe(
      Array.from({ length: 8 }, (_, i) => String(i)).join("\n"),
    );
    expect(truncateDisplay(`${"z".repeat(400)}\n${"y".repeat(400)}`).length).toBe(500);
    const records = parseSessionLogText("out\n" + JSON.stringify({ type: "error", message: "e" }));
    expect(presentCategories(records)).toEqual(["error", "output"]);
    expect(visibleRecords(records, new Set()).map((record) => record.line)).toEqual([1, 2]);
    expect(visibleRecords(records, new Set(["error"])).map((record) => record.category)).toEqual([
      "error",
    ]);
    expect([...toggleSetValue(new Set(["a"]), "b")]).toEqual(["a", "b"]);
    expect([...toggleSetValue(new Set(["a"]), "a")]).toEqual([]);
  });
});
