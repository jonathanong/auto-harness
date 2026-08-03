import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E — see docs/e2e.md.
 * UIs are production builds (`pnpm build:web` then `next start`), not `next dev`.
 * Stack via webServer: DynamoDB+API, control UI, agent UI.
 * fullyParallel: every test is independent (unique ids; no shared mutable fixtures).
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
    baseURL: "http://127.0.0.1:7421",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    /** Use data-pw instead of data-testid */
    testIdAttribute: "data-pw",
  },
  projects: [
    {
      name: "control",
      testMatch: /e2e\/control\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:7421",
      },
    },
    {
      name: "agent",
      testMatch: /e2e\/agent\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:7422",
      },
    },
  ],
  webServer: [
    {
      name: "api",
      command: "pnpm local:dynamodb && pnpm local:dynamodb:ready && pnpm local:api",
      url: "http://127.0.0.1:7420/health",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "control-web",
      // Expect `pnpm build:web` (or test:e2e) already ran — production server only.
      command: "pnpm local:web:start",
      url: "http://127.0.0.1:7421",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "agent-web",
      command: "pnpm local:agent-web:start",
      url: "http://127.0.0.1:7422",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
