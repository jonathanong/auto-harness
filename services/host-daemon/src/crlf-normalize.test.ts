import { describe, expect, it } from "vitest";

import { createCrlfNormalizer } from "./crlf-normalize.ts";

describe("createCrlfNormalizer", () => {
  it("converts a bare newline to CRLF", () => {
    const crlf = createCrlfNormalizer();
    expect(crlf("stdout", "line one\nline two\n")).toBe("line one\r\nline two\r\n");
  });

  it("leaves an already-CRLF chunk untouched", () => {
    const crlf = createCrlfNormalizer();
    expect(crlf("stdout", "line one\r\nline two\r\n")).toBe("line one\r\nline two\r\n");
  });

  it("does not double a CRLF pair split across chunk boundaries", () => {
    const crlf = createCrlfNormalizer();
    expect(crlf("stdout", "line one\r")).toBe("line one\r");
    expect(crlf("stdout", "\nline two\n")).toBe("\nline two\r\n");
  });

  it("tracks pending CR independently per stream", () => {
    const crlf = createCrlfNormalizer();
    expect(crlf("stdout", "out\r")).toBe("out\r");
    // A stderr chunk arriving in between must not consume stdout's pending CR.
    expect(crlf("stderr", "\nerr")).toBe("\r\nerr");
    expect(crlf("stdout", "\nmore\n")).toBe("\nmore\r\n");
  });

  it("passes empty chunks through without touching pending state", () => {
    const crlf = createCrlfNormalizer();
    expect(crlf("stdout", "line\r")).toBe("line\r");
    expect(crlf("stdout", "")).toBe("");
    expect(crlf("stdout", "\nnext\n")).toBe("\nnext\r\n");
  });

  it("normalizes consecutive bare newlines after a split CRLF boundary", () => {
    const crlf = createCrlfNormalizer();
    expect(crlf("stdout", "foo\r")).toBe("foo\r");
    expect(crlf("stdout", "\n\nbar")).toBe("\n\r\nbar");
  });
});
