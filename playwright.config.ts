import { defineConfig, devices } from "@playwright/test";

import {
  API_BASE,
  API_PORT,
  CONTROL_PORT,
  DYNAMO_ENDPOINT,
  HOST_PANE_PORT,
} from "./e2e/harness-endpoints.ts";

const requiredAuthE2e = process.env.HARNESS_E2E_AUTH === "1";
const controlOnly = process.env.HARNESS_E2E_CONTROL_ONLY === "1";
const screenshots = process.env.HARNESS_SCREENSHOTS === "1";
const apiPort = API_PORT;
const controlPort = CONTROL_PORT;
const hostPanePort = HOST_PANE_PORT;
const dynamoEndpoint = DYNAMO_ENDPOINT;
const apiUrl = API_BASE;

/**
 * Playwright E2E — see docs/e2e.md.
 * UIs are production builds (`pnpm build:web:e2e` then `next start`), not `next dev`. The
 * e2e build is a separate `.next-e2e` output (see next.config.ts's `HARNESS_E2E` distDir),
 * because Next.js bakes rewrites() — the API upstream URL — into the build at `next build`
 * time, not at `next start` time.
 * Stack via webServer: DynamoDB+API, control UI, host-pane UI — all on a dedicated 743x
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
    baseURL: `http://127.0.0.1:${controlPort}`,
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
        baseURL: `http://127.0.0.1:${controlPort}`,
      },
    },
    {
      name: "host-pane",
      testMatch: "e2e/host-pane/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${hostPanePort}`,
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
              baseURL: `http://127.0.0.1:${controlPort}`,
            },
          },
        ]
      : []),
    // Design-review before/after screenshots (docs/e2e.md — "Design-review screenshots").
    // Registered only under `pnpm screenshots` so CI's plain `playwright test` never touches
    // it; specs navigate with absolute URLs rather than a single project baseURL since one
    // spec may capture both apps.
    ...(screenshots
      ? [
          {
            name: "screenshots",
            testMatch: "e2e/screenshots/**/*.spec.ts",
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
  ],
  webServer: [
    {
      name: "api",
      command: process.env.HARNESS_E2E_DDB_ENDPOINT
        ? `HARNESS_DDB_ENDPOINT=${dynamoEndpoint} node scripts/ensure-dynamodb.mts && HARNESS_DDB_ENDPOINT=${dynamoEndpoint} node services/api/src/cli.ts serve --port ${apiPort}`
        : "pnpm local:dynamodb:e2e && pnpm local:dynamodb:e2e:ready && pnpm local:api:e2e",
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "control-web",
      // Expect `pnpm build:web:e2e` (or test:e2e) already ran — production server only.
      command: `HARNESS_E2E=1 HARNESS_API_HTTP=${apiUrl} pnpm --filter @auto-harness/web exec next start --port ${controlPort}`,
      url: `http://127.0.0.1:${controlPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    ...(!requiredAuthE2e && !controlOnly
      ? [
          {
            name: "host-pane",
            command: `HARNESS_E2E=1 HARNESS_API_HTTP=${apiUrl} pnpm --filter @auto-harness/host-pane exec next start --port ${hostPanePort}`,
            url: `http://127.0.0.1:${hostPanePort}`,
            reuseExistingServer: false,
            timeout: 60_000,
            stdout: "pipe",
            stderr: "pipe",
          },
        ]
      : []),
  ],
});
