import { describe, expect, it } from "vitest";

import { formatSupplementalLcov } from "./scoped-v8-coverage-provider.mts";

describe("formatSupplementalLcov", () => {
  it("sorts records and emits only executable DA lines", () => {
    expect(
      formatSupplementalLcov([
        {
          path: "services/api/src/z.ts",
          executableLines: new Set([3, 1]),
          hits: { "1": 2, "2": 9 },
        },
        {
          path: "services/api/src/a-types.ts",
          executableLines: new Set(),
          hits: { "1": 0 },
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
});
