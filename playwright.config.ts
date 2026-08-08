import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E — see docs/e2e.md.
 * UIs are production builds (`pnpm build:web:e2e` then `next start`), not `next dev`. The
 * e2e build is a separate `.next-e2e` output (see next.config.ts's `HARNESS_E2E` distDir),
 * because Next.js bakes rewrites() — the API upstream URL — into the build at `next build`
 * time, not at `next start` time.
 * Stack via webServer: DynamoDB+API, control UI, agent UI — all on a dedicated 743x
 * port range (+10 offset from the normal 742x/7423 dev ports) with their own DynamoDB
 * Local container, so a test run never shares state with (or gets confused by) a
 * manual `pnpm local:*` dev session. reuseExistingServer is unconditionally false:
 * every invocation force-recreates the DynamoDB container and restarts the app
 * servers fresh, so no test-created data ever survives across runs.
 * fullyParallel: every test is independent (unique ids; no shared mutable fixtures,
 * except the single "local-1" host both projects seed against — see docs/e2e.md).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:7431",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    /** Use data-pw instead of data-testid */
    testIdAttribute: "data-pw",
  },
  projects: [
    {
      name: "control",
      testMatch: "e2e/control/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:7431",
      },
    },
    {
      name: "agent",
      testMatch: "e2e/agent/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:7432",
      },
    },
    // Real claude/codex sessions — needs local credentials, never runs in CI. Registered
    // only when explicitly opted into, so a bare `playwright test` never picks it up even
    // by accident; `test.skip` inside each spec further guards machines without the binary.
    ...(process.env.HARNESS_REAL_CLI
      ? [
          {
            name: "real-cli",
            testMatch: "e2e/real-cli/**/*.spec.ts",
            use: {
              ...devices["Desktop Chrome"],
              baseURL: "http://127.0.0.1:7431",
            },
          },
        ]
      : []),
  ],
  webServer: [
    {
      name: "api",
      command: "pnpm local:dynamodb:e2e && pnpm local:dynamodb:e2e:ready && pnpm local:api:e2e",
      url: "http://127.0.0.1:7430/health",
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "control-web",
      // Expect `pnpm build:web:e2e` (or test:e2e) already ran — production server only.
      command: "pnpm local:web:start:e2e",
      url: "http://127.0.0.1:7431",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "host-pane",
      command: "pnpm local:host-pane:start:e2e",
      url: "http://127.0.0.1:7432",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
