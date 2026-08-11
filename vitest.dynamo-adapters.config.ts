import { defineConfig } from "vitest/config";

/**
 * Exact coverage gate for the Dynamo catalog and host-lock adapter tranche.
 * It intentionally contains no exclusions: every statement, branch, and
 * function in these four production files must execute against DynamoDB Local.
 */
export default defineConfig({
  test: {
    include: ["modules/**/*.test.ts", "services/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: [
        "services/api/src/db/plane-storage-base.ts",
        "services/api/src/db/plane-storage-catalog.ts",
        "services/api/src/db/plane-storage-catalog-providers.ts",
        "services/api/src/db/plane-storage-locks.ts",
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ["text", "lcov"],
    },
  },
});
