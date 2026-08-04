import { test, expect } from "@playwright/test";

test.describe("host pane status", () => {
  test("loads host shell and status page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("host-shell")).toBeVisible();
    await expect(page.getByTestId("page-host-status")).toBeVisible();
    await expect(page.getByTestId("host-status-id")).toHaveText("local-1");
    await expect(page.getByTestId("nav-status")).toBeVisible();
    await expect(page.getByTestId("nav-repositories")).toBeVisible();
    await expect(page.getByTestId("nav-sessions")).toBeVisible();
    await expect(page.getByTestId("host-drain")).toBeVisible();
  });

  test("stat cards link to their pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("stat-host-config-link")).toHaveAttribute(
      "href",
      "/repositories",
    );
    await expect(page.getByTestId("stat-worktrees-link")).toHaveAttribute("href", "/repositories");
    await expect(page.getByTestId("stat-sessions-link")).toHaveAttribute("href", "/sessions");

    await page.getByTestId("stat-worktrees-link").click();
    await expect(page).toHaveURL(/\/repositories$/);
  });
});
