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
        // Shared, framework-independent display primitives and detail views.
        "modules/ui/src/lib/utils.ts",
        "modules/ui/src/components/{badge,button,card,input,label,table,textarea,status-badge,tip-text,tip-link,tooltip,dialog,confirm-button,toast,cursor-pagination,detail-header,provider-account-health,session-execution-summary,session-route-summary,sessions-table,tabs,repository-detail,session-detail,worktree-detail,worktrees-hierarchy}.tsx",
        "services/host-pane/src/components/{add-repo-dialog,host-config-form,host-shell,provider-accounts-readonly}.tsx",
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
        "**/db/plane-storage-*.ts",
        "**/db/local-bootstrap.ts",
        "**/create-plane.ts",
        // Next.js app routers and app-owned components remain e2e-only. Shared display
        // primitives are explicitly included above and exercised by Vitest.
        "**/app/**",
        "**/services/web/src/components/**",
        // The public barrel is outside this display-primitives tranche; it only
        // re-exports the remaining UI surface, which stays e2e-only for now.
        "**/modules/ui/src/index.ts",
        // Pure re-export of @auto-harness/shared's apiBase/apiGet (tested there);
        // a re-export-only file registers as an uncovered function in v8 coverage.
        "**/services/web/src/lib/api.ts",
        "**/services/web/src/lib/attach-local-repo.ts",
        // Host-pane component coverage is intentionally enabled for the four
        // user-facing components above; routes and server helpers remain e2e-only.
        "**/services/host-pane/src/app/**",
        "**/services/host-pane/src/lib/**",
        "**/services/host-pane/src/middleware.ts",
        "**/services/host-pane/src/index.ts",
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
