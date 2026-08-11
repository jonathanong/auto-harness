import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["modules/**/*.test.{ts,tsx}", "services/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: [
        "modules/*/src/**/*.ts",
        "services/*/src/**/*.ts",
        // Provider scope forms are exercised in happy-dom with real React and Next contexts.
        "services/web/src/components/{provider-default-command-form,provider-scope-table,scope-provider-command-form,scope-provider-enabled-form,repository-provider-accounts-tab,host-provider-accounts-section}.tsx",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*-test-helpers.ts",
        "**/dist/**",
        "**/.next/**",
        "**/types.ts",
        "**/*-types.ts",
        "**/session.ts",
        "**/providers.ts",
        "**/daemon-transport.ts",
        "**/cli.ts",
        // DynamoDB Local SDK wiring — covered by dynamo.test.ts integration, not line-perfect unit coverage
        "**/db/dynamo.ts",
        "**/db/ensure-tables.ts",
        "**/db/plane-storage.ts",
        "**/db/plane-storage-auth.ts",
        "**/db/plane-storage-base.ts",
        "**/db/plane-storage-catalog-providers.ts",
        "**/db/plane-storage-catalog.ts",
        "**/db/plane-storage-clear.ts",
        "**/db/plane-storage-deletion-markers.ts",
        "**/db/plane-storage-locks.ts",
        "**/db/plane-storage-main-checkout-read.ts",
        "**/db/plane-storage-main-checkout-reconnect.ts",
        "**/db/plane-storage-main-checkout.ts",
        "**/db/plane-storage-provider-account-updates.ts",
        "**/db/plane-storage-provider-accounts.ts",
        "**/db/plane-storage-reconnect-rollback.ts",
        "**/db/plane-storage-reconnect.ts",
        "**/db/plane-storage-sessions.ts",
        "**/db/local-bootstrap.ts",
        "**/create-plane.ts",
        // Next.js app routers and app-owned components remain e2e-only.
        "**/app/**",
        "**/modules/ui/**",
        // Pure re-export of @auto-harness/shared's apiBase/apiGet (tested there);
        // a re-export-only file registers as an uncovered function in v8 coverage.
        "**/services/web/src/lib/api.ts",
        "**/services/web/src/lib/attach-local-repo.ts",
        "**/services/host-pane/**",
        // Thin HTTP route wiring (exercised by local-server-management tests)
        "**/local-routes-host-inventory.ts",
        "**/ws-hub.ts",
        "**/ws-transport.ts",
        "**/start-daemon.ts",
        "**/next.config.ts",
        "**/tailwind.config.ts",
      ],
      thresholds: {
        // Unit tests use process cache; DynamoDB Local write-through is covered by dynamo.test.ts
        lines: 98,
        branches: 97,
        functions: 100,
        statements: 98,
      },
      reporter: ["text", "lcov"],
    },
  },
});
