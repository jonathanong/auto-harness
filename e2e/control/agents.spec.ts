import { test, expect } from "@playwright/test";

test.describe("control plane agents", () => {
  test("agents page loads with filters", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("page-agents")).toBeVisible();
    await expect(page.getByTestId("agents-heading")).toHaveText("Agents");
    await expect(page.getByTestId("agent-filters")).toBeVisible();
    await page.getByTestId("agent-filter-online").selectOption("online");
    await expect(page).toHaveURL(/online=online/);
  });
});
