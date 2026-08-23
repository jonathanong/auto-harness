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
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -0,0 +1,3 @@",
      "+one",
      "+two",
      "+three",
    ].join("\n");
    const lcov = ["TN:", "SF:/workspace/src/example.ts", "DA:1,1", "DA:2,0", "end_of_record"].join(
      "\n",
    );
    expect(checkPatchCoverage(diff, lcov)).toMatchObject({
      total: 2,
      covered: 1,
      percentage: 50,
      uncovered: [{ path: "src/example.ts", line: 2 }],
      unmapped: [{ path: "src/example.ts", line: 3 }],
    });
  });

  it("passes an empty or non-coverable patch", () => {
    const result = checkPatchCoverage("", "TN:\n");
    expect(result).toMatchObject({ total: 0, covered: 0, percentage: 100 });
    expect(formatPatchCoverageFailure(result)).toBeUndefined();
  });

  it("allows a 99% threshold when only one of 100 coverable lines misses", () => {
    const lines = Array.from({ length: 100 }, (_, index) => index + 1);
    const diff = new Map([["src/example.ts", new Set(lines)]]);
    const lcov = parseLcov(
      ["SF:src/example.ts", ...lines.map((line) => `DA:${line},${line === 1 ? 0 : 1}`)].join("\n"),
    );
    const result = checkPatchCoverage(diff, lcov);
    expect(result.percentage).toBe(99);
    expect(formatPatchCoverageFailure(result)).toBeUndefined();
  });
});
