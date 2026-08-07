import { test, expect } from "@playwright/test";

test.describe("host pane settings", () => {
  test("/ redirects to /sessions", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByTestId("host-shell")).toBeVisible();
    await expect(page.getByTestId("nav-repositories")).toBeVisible();
    await expect(page.getByTestId("nav-sessions")).toBeVisible();
    await expect(page.getByTestId("nav-settings")).toBeVisible();
  });

  test("header shows an online badge", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.getByTestId("host-shell-online")).toBeVisible();
  });

  test("settings page has drain control and raw host inventory JSON", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("page-settings")).toBeVisible();
    await expect(page.getByTestId("settings-heading")).toHaveText("Settings");
    await expect(page.getByTestId("host-drain")).toBeVisible();
    await expect(page.getByTestId("form-host-config-json")).toBeVisible();
  });
});
