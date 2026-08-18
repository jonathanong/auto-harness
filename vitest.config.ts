import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next preserves JSX for its own compiler; direct server-component tests need
  // Vite to use the same automatic React runtime.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["modules/**/*.test.{ts,tsx}", "services/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: [
        "modules/*/src/**/*.ts",
        "services/*/src/**/*.ts",
        // Provider scope forms are exercised in happy-dom with real React and Next contexts.
        "services/web/src/components/{provider-default-command-form,provider-scope-table,scope-provider-command-form,scope-provider-enabled-form,repository-provider-accounts-tab,host-provider-accounts-section}.tsx",
        // Session and schedule forms are exercised in happy-dom with real React
        // and Next contexts. App routes and the remaining app-owned components stay e2e-only.
        "services/web/src/components/{schedule-create-form,schedule-edit-form,schedule-trigger-button,schedule-enabled-toggle,create-session-form,prompt-markdown-preview,session-prompt-field,session-routing-fields,session-target-select}.tsx",
        "modules/ui/src/lib/utils.ts",
        "modules/ui/src/components/{tooltip,dialog,confirm-button,toast,cursor-pagination,paginated-sessions}.tsx",
        "modules/ui/src/components/{session-search.ts,detail-header.tsx,provider-account-health.tsx,repository-url-copy.tsx,session-execution-summary.tsx,session-exit-code.tsx,session-sort-head.tsx,session-route-summary.tsx,session-status-cell.tsx,session-time.tsx,session-timeout-progress.tsx,sessions-table.tsx,tabs.tsx}",
        "services/web/src/components/{repo-create-form,edit-repo-form,provider-create-form,edit-provider-form,command-create-form,edit-command-form}.tsx",
        "modules/ui/src/components/{repository-detail,session-detail,worktree-detail,worktrees-hierarchy}.tsx",
        "modules/ui/src/components/{add-repo-form,add-worktree-form,path-input,drain-button,remove-repo-button,remove-worktree-button,section-error}.tsx",
        "modules/ui/src/components/{session-actions,session-catalog-filters,session-filters,session-logs}.tsx",
        // Host settings forms are exercised in happy-dom with real React and Next contexts.
        "services/web/src/components/{add-host-form,attach-local-repo-form,attach-provider-account-to-host-form,connect-host-panel,host-provider-account-command-form,host-repo-settings-form,provider-account-cooldown-form}.tsx",
        // Catalog dialogs and destructive actions are exercised with real React in happy-dom.
        "services/web/src/components/{add-command-dialog,add-provider-dialog,add-repo-dialog,delete-command-button,delete-provider-button,delete-repo-button}.tsx",
        "services/web/src/components/{add-provider-account-form,host-repositories-section,remove-provider-account-button,remove-provider-account-from-host-button}.tsx",
        "services/web/src/components/{control-shell,host-filters,edit-worktree-form,list-page-states}.tsx",
        // Settings state and fields are exercised in happy-dom; complete workflows stay in Playwright.
        "services/web/src/components/{settings-page-client,slack-settings-fields,user-account-settings,user-account-create-form,user-account-table}.tsx",
        "services/host-pane/src/components/{add-repo-dialog,host-config-form,host-shell,provider-accounts-readonly,sessions-live}.tsx",
        "services/host-pane/src/app/{layout,page,repositories/page,settings/page}.tsx",
        "services/host-pane/src/lib/{api,inventory}.ts",
        "services/host-pane/src/middleware.ts",
        "services/host-daemon/src/cli.ts",
        "services/web/src/app/commands/page.tsx",
        "services/web/src/app/commands/*/page.tsx",
        "services/web/src/app/providers/page.tsx",
        "services/web/src/app/providers/*/page.tsx",
        "services/web/src/app/repositories/page.tsx",
        "services/web/src/app/repositories/*/page.tsx",
        "services/host-pane/src/app/repositories/[[]id[]]/page.tsx",
        "services/host-pane/src/app/sessions/[[]id[]]/page.tsx",
        "services/host-pane/src/app/worktrees/[[]worktreeId[]]/page.tsx",
        // Shared, framework-independent display primitives are covered by server renders.
        "modules/ui/src/components/{badge,button,card,input,label,table,textarea,session-status-badge,worktree-status-badge,tip-text,tip-link}.tsx",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*-test-helpers.{ts,tsx}",
        "**/dist/**",
        "**/.next/**",
        "**/types.ts",
        "**/*-types.ts",
        // Exact paths, not a `**` glob: these two are pure type-only files today, but a
        // glob would silently drop coverage on any future file that happens to share the
        // name, anywhere in the repo.
        "modules/shared/src/session.ts",
        "modules/shared/src/providers.ts",
        // These two are thin entrypoints; services/host-daemon/src/cli.ts is real
        // argv-parsing and dispatch logic — see its explicit include/threshold below.
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
        // Only the explicitly included control catalog and host-pane routes
        // above enter this coverage tranche; remaining app routes stay e2e-only.
        "**/services/host-pane/src/app/sessions/page.tsx",
        // The public barrel re-exports the broader UI surface, which is outside this tranche.
        "**/modules/ui/src/index.ts",
        // Pure re-export of @auto-harness/shared's apiBase/apiGet (tested there);
        // a re-export-only file registers as an uncovered function in v8 coverage.
        "**/services/web/src/lib/api.ts",
        "**/services/host-pane/src/index.ts",
        "**/next.config.ts",
        "**/tailwind.config.ts",
      ],
      thresholds: {
        // Unit tests use process cache; DynamoDB Local write-through is covered by dynamo.test.ts
        lines: 98,
        branches: 97,
        functions: 100,
        statements: 98,
        "modules/ui/src/components/{session-search.ts,detail-header.tsx,provider-account-health.tsx,repository-url-copy.tsx,session-execution-summary.tsx,session-exit-code.tsx,session-sort-head.tsx,session-route-summary.tsx,session-status-cell.tsx,session-time.tsx,session-timeout-progress.tsx,sessions-table.tsx,tabs.tsx}":
          { 100: true },
        "modules/ui/src/components/{repository-detail,session-detail,worktree-detail,worktrees-hierarchy}.tsx":
          { 100: true },
        "services/web/src/components/{provider-default-command-form,provider-scope-table,scope-provider-command-form,scope-provider-enabled-form,repository-provider-accounts-tab,host-provider-accounts-section}.tsx":
          { 100: true },
        "services/web/src/components/schedule-enabled-toggle.tsx": { 100: true },
        "modules/ui/src/{lib/utils.ts,components/{tooltip,dialog,confirm-button,toast,cursor-pagination,paginated-sessions}.tsx}":
          { 100: true },
        "modules/ui/src/components/use-paginated-sessions.ts": { 100: true },
        "modules/ui/src/components/{badge,button,card,input,label,table,textarea,session-status-badge,worktree-status-badge,tip-text,tip-link}.tsx":
          {
            100: true,
          },
        "services/web/src/components/{repo-create-form,edit-repo-form,provider-create-form,edit-provider-form,command-create-form,edit-command-form}.tsx":
          { 100: true },
        "modules/ui/src/components/{add-repo-form,add-worktree-form,path-input,drain-button,remove-repo-button,remove-worktree-button,section-error}.tsx":
          { 100: true },
        "modules/ui/src/components/{session-actions,session-catalog-filters,session-filters,session-logs}.tsx":
          {
            100: true,
          },
        "services/web/src/components/{add-host-form,attach-local-repo-form,attach-provider-account-to-host-form,connect-host-panel,host-provider-account-command-form,host-repo-settings-form,provider-account-cooldown-form}.tsx":
          { 100: true },
        "services/web/src/components/{add-command-dialog,add-provider-dialog,add-repo-dialog,delete-command-button,delete-provider-button,delete-repo-button}.tsx":
          { 100: true },
        "services/web/src/components/{add-provider-account-form,host-repositories-section,remove-provider-account-button,remove-provider-account-from-host-button}.tsx":
          { 100: true },
        "services/web/src/components/{control-shell,host-filters,edit-worktree-form,user-account-settings,user-account-create-form,user-account-table}.tsx":
          { 100: true },
        "services/host-pane/src/components/{add-repo-dialog,host-config-form,host-shell,provider-accounts-readonly,sessions-live}.tsx":
          { 100: true },
        "services/host-daemon/src/{agent-updater,bootstrap,config,config-parse,daemon-loop,executor,runtime,session-run-claimed,session-runner,start-daemon,worktree-manager,ws-transport,ws-url}.ts":
          {
            100: true,
          },
        "services/api/src/{local-routes-host-inventory,ws-hub}.ts": { 100: true },
        // Real argv-parsing/dispatch logic, unlike the two thin cli.ts entrypoints this
        // module is not covering. `start`'s signal handling is exercised with a real
        // startDaemon against a local WS harness and an injected process, and every
        // closure — including onShutdownSignal's logger, extracted as the named
        // shutdownLoggerFor so a test can invoke it directly — is unit-tested (see
        // cli.test.ts and cli-start-signal.test.ts), so functions is a genuine 100.
        // The one residual gap is lines/branches/statements only:
        // `if (isDirectInvocation(...)) { installCrashLogging(); void main().then(setExitCode); }`
        // runs only when this file is the literal process entrypoint, which a unit test
        // importing the module cannot trigger without re-executing it as a real
        // subprocess — the same limitation the two thin cli.ts files are excluded for
        // entirely. isDirectInvocation and setExitCode are independently tested; only the
        // statement calling them from the top-level guard is unreachable under import.
        "services/host-daemon/src/cli.ts": {
          lines: 98,
          branches: 85,
          functions: 100,
          statements: 98,
        },
        "services/host-pane/src/middleware.ts": { 100: true },
        "services/host-pane/src/lib/inventory.ts": { 100: true },
        // headers()'s success path (forwarding a real cookie/authorization pair) needs a
        // Next.js request context this test environment does not provide; only the
        // no-context catch branch is exercised.
        "services/host-pane/src/lib/api.ts": {
          lines: 94,
          branches: 60,
          functions: 100,
          statements: 94,
        },
        "services/host-pane/src/app/layout.tsx": { 100: true },
        "services/host-pane/src/app/page.tsx": { 100: true },
        "services/host-pane/src/app/repositories/page.tsx": { 100: true },
        "services/host-pane/src/app/settings/page.tsx": { 100: true },
        "services/host-pane/src/app/api/browse/route.ts": { 100: true },
        "services/web/src/app/commands/**/page.tsx": { 100: true },
        "services/web/src/app/providers/**/page.tsx": { 100: true },
        "services/web/src/app/repositories/**/page.tsx": { 100: true },
        "services/host-pane/src/app/repositories/[[]id[]]/page.tsx": { 100: true },
        "services/host-pane/src/app/sessions/[[]id[]]/page.tsx": { 100: true },
        "services/host-pane/src/app/worktrees/[[]worktreeId[]]/page.tsx": { 100: true },
        "services/api/src/db/plane-storage-sessions.ts": { 100: true },
      },
      reporter: ["text", "lcov", "json-summary"],
    },
  },
});
