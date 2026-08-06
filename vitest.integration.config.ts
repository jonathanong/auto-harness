import { defineConfig } from "vitest/config";

/**
 * Full-stack integration tests: real HTTP+WS servers, a real agent daemon,
 * real git — as opposed to vitest.config.ts's unit tests or e2e/*.spec.ts's
 * UI-driven Playwright tests. Own project, own CI job, no coverage gate:
 * these verify end-to-end behavior, not line coverage. See docs/e2e.md.
 */
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
