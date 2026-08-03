import { test, expect } from "@playwright/test";

test.describe("agent pane status", () => {
  test("loads agent shell and status page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("agent-shell")).toBeVisible();
    await expect(page.getByTestId("page-agent-status")).toBeVisible();
    await expect(page.getByTestId("agent-status-id")).toHaveText("local-1");
    await expect(page.getByTestId("nav-status")).toBeVisible();
    await expect(page.getByTestId("nav-repositories")).toBeVisible();
    await expect(page.getByTestId("nav-worktrees")).toBeVisible();
    await expect(page.getByTestId("nav-sessions")).toBeVisible();
    await expect(page.getByTestId("agent-drain")).toBeVisible();
  });

  test("stat cards link to their pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("stat-host-config-link")).toHaveAttribute(
      "href",
      "/repositories",
    );
    await expect(page.getByTestId("stat-worktrees-link")).toHaveAttribute("href", "/worktrees");
    await expect(page.getByTestId("stat-sessions-link")).toHaveAttribute("href", "/sessions");

    await page.getByTestId("stat-worktrees-link").click();
    await expect(page).toHaveURL(/\/worktrees$/);
  });
});
