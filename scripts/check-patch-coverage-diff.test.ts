import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "./check-patch-coverage.mts";

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
