import { test, expect } from "@playwright/test";

test.describe("agent pane config", () => {
  test("config page shows add-repo and raw JSON forms", async ({ page }) => {
    await page.goto("/config");
    await expect(page.getByTestId("page-agent-config")).toBeVisible();
    await expect(page.getByTestId("agent-config-heading")).toBeVisible();
    await expect(page.getByTestId("form-add-local-repo")).toBeVisible();
    await expect(page.getByTestId("add-repo-path")).toBeVisible();
    await expect(page.getByTestId("form-host-config-json")).toBeVisible();
    await expect(page.getByTestId("host-config-json")).toBeVisible();
  });

  test("register local repo via form with unique id", async ({ page }) => {
    const id = `pw-agent-repo-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/config");
    await page.getByTestId("add-repo-id").fill(id);
    await page.getByTestId("add-repo-name").fill(id);
    await page.getByTestId("add-repo-path").fill(`/tmp/${id}`);
    await page.getByTestId("add-repo-submit").click();
    await expect(page.getByTestId("add-repo-ok")).toBeVisible({ timeout: 15_000 });
  });
});
