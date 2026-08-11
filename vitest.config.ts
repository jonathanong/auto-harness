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
        // First UI tranche: shared, framework-independent display primitives.
        "modules/ui/src/lib/utils.ts",
        "modules/ui/src/components/{badge,button,card,input,label,table,textarea,status-badge,tip-text,tip-link,tooltip,dialog,confirm-button,toast,cursor-pagination}.tsx",
        // Control-plane catalog and host settings forms are exercised in happy-dom with
        // real React and Next contexts. App routes and remaining components stay e2e-only.
        "services/web/src/components/{repo-create-form,edit-repo-form,provider-create-form,edit-provider-form,command-create-form,edit-command-form,schedule-create-form,schedule-edit-form,schedule-trigger-button,create-session-form,session-routing-fields,session-target-select,add-host-form,attach-local-repo-form,attach-provider-account-to-host-form,host-provider-account-command-form,host-repo-settings-form,provider-account-cooldown-form}.tsx",
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
        "**/services/host-pane/src/components/**",
        // The public barrel is outside this display-primitives tranche; it only
        // re-exports the remaining UI surface, which stays e2e-only for now.
        "**/modules/ui/src/index.ts",
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
