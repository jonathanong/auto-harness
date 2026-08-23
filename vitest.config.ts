import { defineConfig } from "vitest/config";

import {
  AGGREGATE_COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  PATCH_COVERAGE_EXCLUDE,
} from "./scripts/coverage-scope.mts";

const patchCoverageOutput = process.env.VITEST_PATCH_COVERAGE_PATH;
const coverageCollection = patchCoverageOutput
  ? // The custom module wraps the V8 provider and supports its full option set. Vitest's
    // CustomProviderOptions type omits those underlying-provider fields, so expose the
    // runtime object as V8-compatible after preserving provider: "custom" in its value.
    ({
      provider: "custom",
      customProviderModule: "./scripts/scoped-v8-coverage-provider.mts",
      include: [...COVERAGE_INCLUDE],
      exclude: [...PATCH_COVERAGE_EXCLUDE],
    } as unknown as {
      provider: "v8";
      include: string[];
      exclude: string[];
    })
  : {
      provider: "v8" as const,
      include: [...COVERAGE_INCLUDE],
      exclude: [...AGGREGATE_COVERAGE_EXCLUDE],
    };

export default defineConfig({
  test: {
    // Cap the shared worker pool at 2: GitHub-hosted standard runners have 2 vCPUs, and a
    // larger local pool contends against the single DynamoDB Local endpoint used by tests.
    // Leave the minimum unset so focused runs can still request `--maxWorkers=1`.
    maxWorkers: 2,
    projects: [
      {
        // Next preserves JSX for its own compiler; direct server-component tests need
        // Vite to use the same automatic React runtime.
        esbuild: { jsx: "automatic" },
        test: {
          name: "unit",
          include: [
            "modules/**/*.test.{ts,tsx}",
            "services/**/*.test.{ts,tsx}",
            "scripts/**/*.test.ts",
          ],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Full-stack integration tests: real HTTP+WS servers, a real agent daemon, real git —
        // as opposed to the unit project's mocked-boundary tests or e2e/*.spec.ts's UI-driven
        // Playwright tests. No coverage gate of its own: these verify end-to-end behavior, not
        // line coverage. See docs/e2e.md.
        test: {
          name: "integration",
          include: ["integration/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
    ],
    coverage: {
      ...coverageCollection,
      // Vitest checks thresholds on every `--coverage` run, including a single CI shard's
      // partial subset of files — there's no built-in "skip on shard, enforce once merged"
      // behavior. `pnpm test:shard` sets this so each shard only collects coverage; `pnpm
      // test:merge` (no env var set) is where thresholds are actually enforced, against the
      // merged, whole-suite coverage.
      thresholds: process.env.VITEST_SKIP_COVERAGE_THRESHOLDS
        ? undefined
        : {
            // All aggregate metrics share the same project-wide coverage floor.
            lines: 99,
            branches: 99,
            functions: 99,
            statements: 99,
            // Real argv-parsing/dispatch logic. The residual gap is the top-level
            // `isDirectInvocation` guard, which a unit test importing the module cannot
            // trigger without re-executing this file as a subprocess.
            "services/host-daemon/src/cli.ts": {
              lines: 98,
              branches: 85,
              functions: 100,
              statements: 98,
            },
            // headers()'s success path needs a Next.js request context this test
            // environment does not provide; only the no-context catch branch is exercised.
            "services/host-pane/src/lib/api.ts": {
              lines: 94,
              branches: 60,
              functions: 100,
              statements: 94,
            },
          },
      reporter: ["text", "lcov", "json-summary"],
    },
  },
});
