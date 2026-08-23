import { describe, expect, it } from "vitest";

import { formatSupplementalLcov, isEmptyCoverageReport } from "./scoped-v8-coverage-provider.mts";

describe("formatSupplementalLcov", () => {
  it("sorts records and emits only executable DA lines", () => {
    expect(
      formatSupplementalLcov([
        {
          path: "services/api/src/z.ts",
          hits: { "3": 0, "1": 2 },
        },
        {
          path: "services/api/src/a-types.ts",
          hits: {},
        },
      ]),
    ).toBe(
      [
        "TN:",
        "SF:services/api/src/a-types.ts",
        "end_of_record",
        "TN:",
        "SF:services/api/src/z.ts",
        "DA:1,2",
        "DA:3,0",
        "end_of_record",
        "",
      ].join("\n"),
    );
  });

  it("writes an empty report when there are no supplemental files", () => {
    expect(formatSupplementalLcov([])).toBe("");
  });

  it("recognizes Vitest's all-files placeholder coverage", () => {
    expect(isEmptyCoverageReport({ fnMap: { "0": { name: "(empty-report)" } } })).toBe(true);
    expect(isEmptyCoverageReport({ fnMap: { "0": { name: "createPlane" } } })).toBe(false);
  });
});
