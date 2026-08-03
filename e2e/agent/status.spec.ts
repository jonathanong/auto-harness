import { test, expect } from "@playwright/test";

test.describe("agent pane status", () => {
  test("loads agent shell and status page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("agent-shell")).toBeVisible();
    await expect(page.getByTestId("page-agent-status")).toBeVisible();
    await expect(page.getByTestId("agent-status-id")).toHaveText("local-1");
    await expect(page.getByTestId("nav-status")).toBeVisible();
    await expect(page.getByTestId("nav-config")).toBeVisible();
    await expect(page.getByTestId("agent-drain")).toBeVisible();
  });
});
