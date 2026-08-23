import { describe, expect, it } from "vitest";

import {
  checkPatchCoverage,
  formatPatchCoverageFailure,
  parseLcov,
  parseUnifiedDiff,
} from "./check-patch-coverage.mts";

describe("parseUnifiedDiff", () => {
  it("collects added lines from zero-context hunks", () => {
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -2,0 +3,2 @@",
      "+new line",
      "+another line",
      "@@ -8,1 +10,1 @@",
      "-old",
      "+replacement",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual(new Map([["src/example.ts", new Set([3, 4, 10])]]));
  });

  it("handles quoted paths and ignores deleted files", () => {
    const diff = [
      'diff --git "a/src/space file.ts" "b/src/space file.ts"',
      '--- "a/src/space file.ts"',
      '+++ "b/src/space file.ts"',
      "@@ -0,0 +1,1 @@",
      "+added",
      "diff --git a/deleted.ts b/deleted.ts",
      "deleted file mode 100644",
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-deleted",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual(new Map([["src/space file.ts", new Set([1])]]));
  });

  it("handles unquoted UTF-8 paths emitted with core.quotepath disabled", () => {
    const diff = [
      "diff --git a/modules/shared/src/café.ts b/modules/shared/src/café.ts",
      "--- a/modules/shared/src/café.ts",
      "+++ b/modules/shared/src/café.ts",
      "@@ -0,0 +1,1 @@",
      "+export const café = true;",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual(new Map([["modules/shared/src/café.ts", new Set([1])]]));
  });
});

describe("checkPatchCoverage", () => {
  it("counts DA records and reports uncovered lines", () => {
    const path = "services/api/src/example.ts";
    const diff = [
      `diff --git a/${path} b/${path}`,
      `+++ b/${path}`,
      "@@ -0,0 +1,3 @@",
      "+export const one = 1;",
      "+export const two = 2;",
      "+export const three = 3;",
    ].join("\n");
    const lcov = ["TN:", `SF:/workspace/${path}`, "DA:1,1", "DA:2,0", "end_of_record"].join("\n");
    const source = [
      "export const one = 1;",
      "export const two = 2;",
      "export const three = 3;",
    ].join("\n");
    const result = checkPatchCoverage(diff, lcov, 99, () => source);
    expect(result).toMatchObject({
      total: 3,
      covered: 1,
      uncovered: [
        { path, line: 2 },
        { path, line: 3 },
      ],
      unmapped: [{ path, line: 3 }],
      missingFiles: [],
    });
    expect(result.percentage).toBeCloseTo(100 / 3);
  });

  it("passes an empty or non-coverable patch", () => {
    const result = checkPatchCoverage("", "TN:\n");
    expect(result).toMatchObject({ total: 0, covered: 0, percentage: 100 });
    expect(formatPatchCoverageFailure(result)).toBeUndefined();
  });

  it("allows a 99% threshold when only one of 100 coverable lines misses", () => {
    const lines = Array.from({ length: 100 }, (_, index) => index + 1);
    const path = "services/api/src/example.ts";
    const diff = new Map([[path, new Set(lines)]]);
    const lcov = parseLcov(
      [`SF:${path}`, ...lines.map((line) => `DA:${line},${line === 1 ? 0 : 1}`)].join("\n"),
    );
    const source = lines.map((line) => `export const value${line} = ${line};`).join("\n");
    const result = checkPatchCoverage(diff, lcov, 99, () => source);
    expect(result.percentage).toBe(99);
    expect(formatPatchCoverageFailure(result)).toBeUndefined();
  });

  it("fails closed when an executable production file has no SF record", () => {
    const path = "services/api/src/new-runtime.ts";
    const result = checkPatchCoverage(
      new Map([[path, new Set([1])]]),
      "TN:\n",
      99,
      () => "export const enabled = true;",
    );
    expect(result).toMatchObject({
      total: 1,
      covered: 0,
      missingFiles: [path],
      uncovered: [{ path, line: 1 }],
      unmapped: [{ path, line: 1 }],
    });
    expect(formatPatchCoverageFailure(result)).toContain(
      `Changed executable files missing from LCOV: ${path}`,
    );
  });

  it("omits non-executable additions even when their measured file has no DA", () => {
    const path = "modules/shared/src/constants.ts";
    const source = ["export const value = 1;", "// Clarify why this is stable."].join("\n");
    const result = checkPatchCoverage(
      new Map([[path, new Set([2])]]),
      `SF:${path}\nDA:1,1\nend_of_record`,
      99,
      () => source,
    );
    expect(result).toMatchObject({
      total: 0,
      percentage: 100,
      uncovered: [],
      unmapped: [],
      missingFiles: [],
    });
    expect(formatPatchCoverageFailure(result)).toBeUndefined();
  });

  it("gates executable additions in an aggregate-excluded Dynamo adapter", () => {
    const path = "services/api/src/db/plane-storage-auth.ts";
    const result = checkPatchCoverage(
      new Map([[path, new Set([1])]]),
      `SF:${path}\nDA:1,0\nend_of_record`,
      99,
      () => "export function loadAccount(): void {}",
    );
    expect(result).toMatchObject({
      total: 1,
      covered: 0,
      uncovered: [{ path, line: 1 }],
      missingFiles: [],
    });
    expect(formatPatchCoverageFailure(result)).toContain(`Uncovered added lines: ${path}:1`);
  });

  it("ignores docs, tests, declarations, pure types, and deliberate entrypoints", () => {
    const paths = [
      "docs/coverage.md",
      "services/api/src/example.test.ts",
      "services/api/src/globals.d.ts",
      "services/api/src/new-types.ts",
      "services/api/src/cli.ts",
      "modules/ui/src/index.ts",
    ];
    const sources: Record<string, string> = {
      "services/api/src/new-types.ts": "export type Example = { id: string };",
    };
    const result = checkPatchCoverage(
      new Map(paths.map((path) => [path, new Set([1])])),
      "TN:\n",
      99,
      (path) => sources[path] ?? "export const runtime = true;",
    );
    expect(result).toMatchObject({
      total: 0,
      percentage: 100,
      missingFiles: [],
    });
    expect(formatPatchCoverageFailure(result)).toBeUndefined();
  });

  it("merges duplicate shard records using the highest line hit count", () => {
    const path = "services/api/src/db/plane-storage-clear.ts";
    const lcov = [
      `SF:${path}`,
      "DA:1,0",
      "end_of_record",
      `SF:/workspace/${path}`,
      "DA:1,3",
      "end_of_record",
    ].join("\n");
    const result = checkPatchCoverage(
      new Map([[path, new Set([1])]]),
      lcov,
      99,
      () => "export const clear = true;",
    );
    expect(result).toMatchObject({ total: 1, covered: 1, percentage: 100 });
    expect(formatPatchCoverageFailure(result)).toBeUndefined();
  });
});
