import { test, expect } from "@playwright/test";

import { withLocalHostLock } from "../local-1-host.ts";

test.describe("host pane settings", () => {
  test("/ redirects to /sessions", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByTestId("host-shell")).toBeVisible();
    await expect(page.getByTestId("nav-repositories")).toBeVisible();
    await expect(page.getByTestId("nav-sessions")).toBeVisible();
    await expect(page.getByTestId("nav-settings")).toBeVisible();
  });

  test("header shows an explicit connection badge", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.getByTestId("host-shell-online")).toHaveText(/^(Online|Offline)$/);
  });

  test("settings page has drain control and raw host inventory JSON", async ({ page }) => {
    await withLocalHostLock(async () => {
      await page.goto("/settings");
      await expect(page.getByTestId("page-settings")).toBeVisible();
      await expect(page.getByTestId("settings-heading")).toHaveText("Settings");
      await expect(page.getByTestId("host-drain")).toBeVisible();
      await expect(page.getByTestId("form-host-config-json")).toBeVisible();
      await expect(page.getByTestId("host-config-json")).toBeVisible();
      await expect(page.getByTestId("host-config-error")).toBeHidden();
      await expect(page.getByTestId("host-config-ok")).toHaveCount(0);
      await page.getByTestId("host-config-submit").click();
      await expect(page.getByTestId("host-config-ok")).toHaveText("Saved.", {
        timeout: 15_000,
      });
    });
  });

  test("settings page shows a read-only provider accounts mirror", async ({ page }) => {
    await page.goto("/settings");
    // No accounts attached to this fresh e2e host — the empty state is the only reliable
    // assertion without seeding a host-provider-account attachment for this spec.
    await expect(page.getByTestId("provider-accounts-readonly-empty")).toBeVisible();
    await expect(page.getByTestId("provider-accounts-readonly")).toHaveCount(0);
    await expect(page.locator('[data-pw^="provider-accounts-readonly-row-"]')).toHaveCount(0);
  });
});
