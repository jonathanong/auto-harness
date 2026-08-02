import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["modules/**/*.test.ts", "services/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["modules/*/src/**/*.ts", "services/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/types.ts", "**/session.ts", "**/cli.ts"],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
      reporter: ["text", "lcov"],
    },
  },
});
