import { expect, test } from "@playwright/test";

import { CONTROL_BASE, HOST_PANE_BASE, shot } from "./lib.ts";

/**
 * Proves the screenshot harness end-to-end (see docs/e2e.md — "Design-review screenshots").
 * Design-review PRs add one spec per finding alongside their fix; this one has no paired
 * finding — it exists so `pnpm screenshots` never runs against an empty test set.
 */
test.describe("screenshot harness smoke", () => {
  test("captures the control-plane dashboard", async ({ page }) => {
    await page.goto(`${CONTROL_BASE}/`);
    await expect(page.getByTestId("app-title")).toBeVisible();
    await shot(page, "harness-smoke-control-dashboard");
  });

  test("captures the host-pane shell", async ({ page }) => {
    await page.goto(`${HOST_PANE_BASE}/`);
    await expect(page.getByTestId("app-title")).toBeVisible();
    await shot(page, "harness-smoke-host-pane");
  });
});
