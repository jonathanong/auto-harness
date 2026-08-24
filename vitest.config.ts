import { defineConfig } from "vitest/config";
import { loadCoverageConfig } from "coverage-check";

const scope = loadCoverageConfig(".coverage-rules.yml").scope;
if (!scope) throw new Error(".coverage-rules.yml must define coverage scope");

const supplementalCoverageOutput = process.env.COVERAGE_CHECK_SUPPLEMENTAL_LCOV;
const coverageCollection = supplementalCoverageOutput
  ? // The custom module wraps the V8 provider and supports its full option set. Vitest's
    // CustomProviderOptions type omits those underlying-provider fields, so expose the
    // runtime object as V8-compatible after preserving provider: "custom" in its value.
    ({
      provider: "custom",
      customProviderModule: "coverage-check/vitest",
      include: [...scope.include],
      exclude: [...scope.ignored],
    } as unknown as {
      provider: "v8";
      include: string[];
      exclude: string[];
    })
  : {
      provider: "v8" as const,
      include: [...scope.include],
      exclude: [...scope.ignored, ...scope.supplemental],
    };

const dynamoUnitTests = [
  "services/api/src/db/**/*.test.ts",
  "services/api/src/**/*durable*.test.ts",
  "services/api/src/**/*dynamo*.test.ts",
  "services/api/src/archive-writer-dynamo.test.ts",
  "services/api/src/local-server-slack-worker.test.ts",
  "services/api/src/local-server-webhook-worker.test.ts",
  "services/api/src/control-plane-providers-storage.test.ts",
  "services/api/src/control-plane-storage-paths.test.ts",
  "services/api/src/control-plane-agent-restart-observability.test.ts",
  "services/api/src/control-plane-scheduled-cancel-race.test.ts",
  "services/api/src/control-plane-scheduled-missing-provider.test.ts",
  "services/api/src/control-plane-scheduled-registration-rollback.test.ts",
  "services/api/src/control-plane-scheduled-recovery.test.ts",
];

const serializedDynamo = {
  fileParallelism: false,
  pool: "forks" as const,
  poolOptions: { forks: { singleFork: true } },
  testTimeout: 60_000,
  hookTimeout: 60_000,
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
          exclude: dynamoUnitTests,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // DynamoDB Local tests share one endpoint. Run them one file at a time rather than
        // raising the 60s timeout to absorb transaction contention.
        test: {
          name: "dynamo",
          include: [...dynamoUnitTests, "integration/**/*.test.ts"],
          ...serializedDynamo,
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
