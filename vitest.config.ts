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
        "**/db/plane-storage-*.ts",
        "**/db/local-bootstrap.ts",
        "**/create-plane.ts",
        // Next.js app routers + UI (manual / e2e; not unit-covered line-perfect)
        "**/app/**",
        "**/components/**",
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
