import { test, expect } from "@playwright/test";

test.describe("control plane repositories", () => {
  test("repositories page loads with add-repository dialog closed", async ({ page }) => {
    await page.goto("/repositories");
    await expect(page.getByTestId("page-repositories")).toBeVisible();
    await expect(page.getByTestId("repositories-heading")).toHaveText("Repositories");
    await expect(page.getByTestId("add-repo-open")).toBeVisible();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();
    await expect(page.getByText("Worktrees by repository")).toBeVisible();
  });

  test("create catalog repository via modal, then open its detail page", async ({ page }) => {
    const id = `pw-repo-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/repositories");
    await page.getByTestId("add-repo-open").click();
    await expect(page.getByTestId("form-repo-catalog")).toBeVisible();
    await page.getByTestId("repo-catalog-id").fill(id);
    await page.getByTestId("repo-catalog-name").fill(`Name ${id}`);
    await page.getByTestId("repo-catalog-url").fill(`/tmp/${id}`);
    await page.getByTestId("repo-catalog-submit").click();
    await expect(page.getByTestId(`repo-link-${id}`)).toBeVisible({ timeout: 15_000 });

    // The dialog doesn't auto-close on success (user reviews the confirmation) — its
    // overlay blocks clicks elsewhere on the page until dismissed.
    await page.getByTestId("dialog-close").click();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();

    await page.getByTestId(`repo-link-${id}`).click();
    await expect(page).toHaveURL(new RegExp(`/repositories/${id}$`));
    await expect(page.getByTestId("repository-detail-id")).toHaveText(id);
    await expect(page.getByTestId("repository-detail-path")).toHaveText(`/tmp/${id}`);
  });

  test("unknown repository id shows a not-found state", async ({ page }) => {
    await page.goto("/repositories/does-not-exist-xyz");
    await expect(page.getByTestId("page-repository-detail-not-found")).toBeVisible();
  });
});
