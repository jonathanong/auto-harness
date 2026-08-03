import { test, expect } from "@playwright/test";

test.describe("control plane dashboard", () => {
  test("loads shell and dashboard stats", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("control-shell")).toBeVisible();
    await expect(page.getByTestId("page-dashboard")).toBeVisible();
    await expect(page.getByTestId("dashboard-heading")).toHaveText("Dashboard");
    await expect(page.getByTestId("dashboard-stats")).toBeVisible();
    await expect(page.getByTestId("stat-running-value")).toBeVisible();
    await expect(page.getByTestId("stat-queued-value")).toBeVisible();
    await expect(page.getByTestId("stat-agents-online-value")).toBeVisible();
  });

  test("nav links are present", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("nav-dashboard")).toBeVisible();
    await expect(page.getByTestId("nav-sessions")).toBeVisible();
    await expect(page.getByTestId("nav-session-new")).toBeVisible();
    await expect(page.getByTestId("nav-repositories")).toBeVisible();
    await expect(page.getByTestId("nav-worktrees")).toBeVisible();
    await expect(page.getByTestId("nav-schedules")).toBeVisible();
    await expect(page.getByTestId("nav-agents")).toBeVisible();
  });
});
