import { test, expect } from "@playwright/test";

test.describe("control plane agents", () => {
  test("agents page loads with filters and add form", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("page-agents")).toBeVisible();
    await expect(page.getByTestId("agents-heading")).toHaveText("Agents");
    await expect(page.getByTestId("form-add-agent")).toBeVisible();
    await expect(page.getByTestId("agent-filters")).toBeVisible();
    await page.getByTestId("agent-filter-online").selectOption("online");
    await expect(page).toHaveURL(/online=online/);
  });

  test("add agent creates empty host inventory slot", async ({ page }) => {
    const id = `pw-agent-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/agents");
    await page.getByTestId("add-agent-id").fill(id);
    await page.getByTestId("add-agent-submit").click();
    await expect(page.getByTestId("add-agent-ok")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`agent-row-${id}`)).toBeVisible({ timeout: 15_000 });
  });
});
