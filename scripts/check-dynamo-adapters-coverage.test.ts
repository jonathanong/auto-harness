import { describe, expect, it } from "vitest";

import {
  type CoverageSummary,
  validateDynamoAdapterCoverage,
} from "./check-dynamo-adapters-coverage.mts";

const targets = [
  "services/api/src/db/plane-storage-base.ts",
  "services/api/src/db/plane-storage-catalog.ts",
  "services/api/src/db/plane-storage-catalog-providers.ts",
  "services/api/src/db/plane-storage-locks.ts",
];

function completeSummary(): CoverageSummary {
  return Object.fromEntries(
    targets.map((target) => [
      `/workspace/${target}`,
      {
        lines: { pct: 100, total: 1 },
        branches: { pct: 100, total: 1 },
        functions: { pct: 100, total: 1 },
        statements: { pct: 100, total: 1 },
      },
    ]),
  );
}

describe("validateDynamoAdapterCoverage", () => {
  it("accepts exactly complete coverage for every enforced file", () => {
    expect(validateDynamoAdapterCoverage(completeSummary())).toEqual([]);
  });

  it("rejects missing files, zero totals, and non-exact metrics", () => {
    const summary = completeSummary();
    delete summary["/workspace/services/api/src/db/plane-storage-base.ts"];
    summary["/workspace/services/api/src/db/plane-storage-catalog.ts"]!.branches = {
      pct: 99,
      total: 10,
    };
    summary["/workspace/services/api/src/db/plane-storage-catalog-providers.ts"]!.lines = {
      pct: 100,
      total: 0,
    };

    expect(validateDynamoAdapterCoverage(summary)).toEqual([
      "Coverage summary is missing services/api/src/db/plane-storage-base.ts.",
      "services/api/src/db/plane-storage-catalog.ts branches coverage must be 100% (received 99%).",
      "services/api/src/db/plane-storage-catalog-providers.ts lines coverage must be 100% (received 100%).",
    ]);
  });
});
