import { test, expect } from "@playwright/test";

test.describe("control plane repositories", () => {
  test("repositories page loads", async ({ page }) => {
    await page.goto("/repositories");
    await expect(page.getByTestId("page-repositories")).toBeVisible();
    await expect(page.getByTestId("repositories-heading")).toHaveText("Repositories");
    await expect(page.getByTestId("form-repo-catalog")).toBeVisible();
  });

  test("create catalog repository with unique id", async ({ page }) => {
    const id = `pw-repo-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/repositories");
    await page.getByTestId("repo-catalog-id").fill(id);
    await page.getByTestId("repo-catalog-name").fill(`Name ${id}`);
    await page.getByTestId("repo-catalog-url").fill(`/tmp/${id}`);
    await page.getByTestId("repo-catalog-submit").click();
    await expect(page.getByText(id).first()).toBeVisible({ timeout: 15_000 });
  });
});
