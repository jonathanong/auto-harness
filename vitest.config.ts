import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["modules/**/*.test.ts", "services/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["modules/*/src/**/*.ts", "services/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/dist/**",
        "**/types.ts",
        "**/session.ts",
        "**/cli.ts",
        // DynamoDB Local SDK wiring — covered by dynamo.test.ts integration, not line-perfect unit coverage
        "**/db/dynamo.ts",
        "**/db/ensure-tables.ts",
        "**/db/plane-storage.ts",
        "**/db/local-bootstrap.ts",
        "**/create-plane.ts",
      ],
      thresholds: {
        // Unit tests use process cache; DynamoDB Local write-through is covered by dynamo.test.ts
        lines: 99,
        branches: 98,
        functions: 100,
        statements: 99,
      },
      reporter: ["text", "lcov"],
    },
  },
});
