import { test, expect } from "@playwright/test";

test.describe("control plane hosts", () => {
  test("hosts page loads with filters and add form", async ({ page }) => {
    await page.goto("/hosts");
    await expect(page.getByTestId("page-hosts")).toBeVisible();
    await expect(page.getByTestId("hosts-heading")).toHaveText("Hosts");
    await expect(page.getByTestId("form-add-host")).toBeVisible();
    await expect(page.getByTestId("host-filters")).toBeVisible();
    await page.getByTestId("host-filter-online").selectOption("online");
    await expect(page).toHaveURL(/online=online/);
  });

  test("add host creates empty host inventory slot", async ({ page }) => {
    const id = `pw-host-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/hosts");
    await page.getByTestId("add-host-id").fill(id);
    await page.getByTestId("add-host-submit").click();
    await expect(page.getByTestId("add-host-ok")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`host-row-${id}`)).toBeVisible({ timeout: 15_000 });

    // Drain is a no-op-safe REST call for an offline slot — just confirm it round-trips.
    await page.getByTestId(`host-drain-${id}`).click();
    await expect(page.getByTestId(`host-drain-${id}`)).toBeEnabled({ timeout: 15_000 });
  });
});
