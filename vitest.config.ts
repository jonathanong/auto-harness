import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pin the shared worker pool at 2: GitHub-hosted standard runners have 2 vCPUs, and a
    // larger local pool contends against the single DynamoDB Local endpoint used by tests.
    maxWorkers: 2,
    minWorkers: 2,
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
      provider: "v8",
      include: ["modules/*/src/**/*.{ts,tsx}", "services/*/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*-test-helpers.{ts,tsx}",
        "**/*.d.ts",
        "**/dist/**",
        "**/.next/**",
        "**/types.ts",
        "**/*-types.ts",
        "**/next.config.ts",
        "**/tailwind.config.ts",
        // Exact paths, not a `**` glob: these two are pure type-only files today, but a
        // glob would silently drop coverage on any future file that happens to share the
        // name, anywhere in the repo.
        "modules/shared/src/session.ts",
        "modules/shared/src/providers.ts",
        // Thin entrypoints; services/host-daemon/src/cli.ts is real argv-parsing and
        // dispatch logic and stays in the include set.
        "services/{api,cdk}/src/cli.ts",
        // Follow-up DynamoDB storage-adapter coverage tranches retain the split
        // implementations. The core client/table/bootstrap adapter is covered here
        // with real-Dynamo integration tests.
        "**/db/plane-storage-auth.ts",
        "**/db/plane-storage-clear.ts",
        "**/db/plane-storage-deletion-markers.ts",
        "**/db/plane-storage-main-checkout-read.ts",
        "**/db/plane-storage-main-checkout-reconnect.ts",
        "**/db/plane-storage-main-checkout.ts",
        "**/db/plane-storage-provider-account-updates.ts",
        "**/db/plane-storage-provider-accounts.ts",
        "**/db/plane-storage-reconnect-rollback.ts",
        "**/db/plane-storage-reconnect.ts",
        "**/create-plane.ts",
        // Public barrels / re-exports register as uncovered functions in v8 coverage.
        "**/modules/ui/src/index.ts",
        "**/services/web/src/lib/api.ts",
        "**/services/host-pane/src/index.ts",
      ],
      // Vitest checks thresholds on every `--coverage` run, including a single CI shard's
      // partial subset of files — there's no built-in "skip on shard, enforce once merged"
      // behavior. `pnpm test:shard` sets this so each shard only collects coverage; `pnpm
      // test:merge` (no env var set) is where thresholds are actually enforced, against the
      // merged, whole-suite coverage.
      thresholds: process.env.VITEST_SKIP_COVERAGE_THRESHOLDS
        ? undefined
        : {
            // Preserve the established aggregate floors while lowering the former exact
            // function requirement to the shared 99% project target.
            lines: 98,
            branches: 97,
            functions: 99,
            statements: 98,
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
