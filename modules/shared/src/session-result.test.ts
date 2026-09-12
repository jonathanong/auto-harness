/* eslint-disable max-lines -- normalization and strict-guard boundary cases share fixtures. */
import { describe, expect, it } from "vitest";

import {
  MAX_SESSION_RESULT_BYTES,
  MAX_SESSION_RESULT_FILES,
  isSessionResult,
  normalizeSessionResult,
} from "./session-result.ts";

describe("session result normalization", () => {
  it("rejects malformed envelopes, sources, and summaries", () => {
    expect(normalizeSessionResult(undefined)).toBeUndefined();
    expect(normalizeSessionResult(false)).toBeUndefined();
    expect(normalizeSessionResult([])).toBeUndefined();
    expect(normalizeSessionResult({ summarySource: "unknown", summary: "done" })).toBeUndefined();
    expect(normalizeSessionResult({ summarySource: "agent" })).toBeUndefined();
    expect(normalizeSessionResult({ summarySource: "agent", summary: 42 })).toBeUndefined();
    expect(normalizeSessionResult({ summarySource: "agent", summary: "" })).toBeUndefined();
  });

  it("rejects malformed results and preserves valid fields", () => {
    expect(normalizeSessionResult(null)).toBeUndefined();
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "agent",
        branch: "main",
        filesChanged: ["b", "a"],
        pullRequestUrl: "https://github.com/example/repo/pull/1",
      }),
    ).toEqual({
      summary: "done",
      summarySource: "agent",
      branch: "main",
      filesChanged: ["a", "b"],
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    });
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "agent",
        pullRequestUrl: "https://%",
      }),
    ).not.toHaveProperty("pullRequestUrl");
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "agent",
        pullRequestUrl: `https://example.com/${"x".repeat(3_000)}`,
      }),
    ).not.toHaveProperty("pullRequestUrl");
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "agent",
        branch: 42,
        pullRequestUrl: "ftp://example.com/pr/1",
        filesChanged: "not-an-array",
      }),
    ).toEqual({ summary: "done", summarySource: "agent" });
  });

  it("omits oversized branch names instead of truncating the identifier", () => {
    const oversizedBranch = `feature/${"x".repeat(2_000)}`;
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "harness",
        branch: oversizedBranch,
      }),
    ).toEqual({ summary: "done", summarySource: "harness" });
  });

  it("filters, deduplicates, sorts, and handles empty changed-file lists", () => {
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "agent",
        filesChanged: [null, "", "z.ts", "a.ts", "z.ts"],
      }),
    ).toEqual({
      summary: "done",
      summarySource: "agent",
      filesChanged: ["a.ts", "z.ts"],
    });
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "agent",
        filesChanged: [],
      }),
    ).toEqual({ summary: "done", summarySource: "agent", filesChanged: [] });
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "agent",
        filesChanged: [null, 42],
      }),
    ).toEqual({ summary: "done", summarySource: "agent" });
  });

  it("does not mutate the peer-provided result while normalizing it", () => {
    const input = {
      summary: "done",
      summarySource: "agent" as const,
      filesChanged: ["b.ts", "a.ts", "b.ts"],
    };
    const before = structuredClone(input);
    expect(normalizeSessionResult(input)).toEqual({
      summary: "done",
      summarySource: "agent",
      filesChanged: ["a.ts", "b.ts"],
    });
    expect(input).toEqual(before);
  });

  it("preserves an explicit changed-file truncation marker", () => {
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "harness",
        filesChanged: ["only-visible-path"],
        filesChangedTruncated: true,
      }),
    ).toMatchObject({ filesChanged: ["only-visible-path"], filesChangedTruncated: true });
  });

  it("bounds paths and total JSON size while marking truncation", () => {
    const result = normalizeSessionResult({
      summary: "x".repeat(10_000),
      summarySource: "harness",
      filesChanged: [
        "ok.ts",
        ...Array.from(
          { length: MAX_SESSION_RESULT_FILES + 10 },
          (_, i) => `${i}-${"x".repeat(10_000)}`,
        ),
      ],
      filesChangedTruncated: true,
    });
    expect(result).toBeDefined();
    expect(result!.filesChangedTruncated).toBe(true);
    expect(result!.filesChanged!.length).toBeLessThanOrEqual(MAX_SESSION_RESULT_FILES);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MAX_SESSION_RESULT_BYTES,
    );
  });

  it("drops oversized paths and marks the changed-file list as truncated", () => {
    expect(
      normalizeSessionResult({
        summary: "done",
        summarySource: "harness",
        filesChanged: [`${"x".repeat(4 * 1024 + 1)}`, "kept.ts"],
      }),
    ).toEqual({
      summary: "done",
      summarySource: "harness",
      filesChanged: ["kept.ts"],
      filesChangedTruncated: true,
    });
  });

  it("marks an oversized summary instead of hiding the truncation", () => {
    const result = normalizeSessionResult({
      summary: "x".repeat(10_000),
      summarySource: "agent",
    });
    expect(result).toMatchObject({ summaryTruncated: true });
    expect(new TextEncoder().encode(result!.summary).byteLength).toBeLessThanOrEqual(4 * 1024);
  });

  it("recognizes only strictly valid result values without normalizing them", () => {
    expect(isSessionResult({ summary: "done", summarySource: "harness" })).toBe(true);
    expect(isSessionResult({ summary: "done", summarySource: "other" })).toBe(false);
    expect(isSessionResult({ summary: "done", summarySource: "harness", branch: 42 })).toBe(false);
    expect(isSessionResult({ summary: "done", summarySource: "harness", filesChanged: [42] })).toBe(
      false,
    );
    expect(
      isSessionResult({
        summary: "done",
        summarySource: "harness",
        filesChanged: [`${"x".repeat(4 * 1024 + 1)}`],
      }),
    ).toBe(false);
  });

  it("rejects every bounded optional field that is malformed on a stored result", () => {
    expect(isSessionResult(undefined)).toBe(false);
    expect(isSessionResult(false)).toBe(false);
    expect(isSessionResult([])).toBe(false);
    expect(isSessionResult({ summary: "", summarySource: "harness" })).toBe(false);
    expect(
      isSessionResult({
        summary: "done",
        summarySource: "harness",
        summaryTruncated: false,
      }),
    ).toBe(false);
    expect(
      isSessionResult({
        summary: "done",
        summarySource: "harness",
        branch: "x".repeat(1_025),
      }),
    ).toBe(false);
    expect(
      isSessionResult({
        summary: "done",
        summarySource: "harness",
        pullRequestUrl: "not a URL",
      }),
    ).toBe(false);
    expect(
      isSessionResult({
        summary: "done",
        summarySource: "harness",
        filesChanged: Array.from(
          { length: MAX_SESSION_RESULT_FILES + 1 },
          (_, index) => `${index}`,
        ),
      }),
    ).toBe(false);
    expect(
      isSessionResult({
        summary: "done",
        summarySource: "harness",
        filesChanged: "not an array",
      }),
    ).toBe(false);
    expect(
      isSessionResult({
        summary: "done",
        summarySource: "harness",
        filesChangedTruncated: false,
      }),
    ).toBe(false);
  });
});
