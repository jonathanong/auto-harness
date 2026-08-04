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
    // Name must be a lowercase-dash slug — id is now auto-generated, never typed.
    const name = `pw-repo-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/repositories");
    await page.getByTestId("add-repo-open").click();
    await expect(page.getByTestId("form-repo-catalog")).toBeVisible();
    await page.getByTestId("repo-catalog-name").fill(name);
    await page.getByTestId("repo-catalog-url").fill(`/tmp/${name}`);
    await page.getByTestId("repo-catalog-submit").click();
    await expect(page.getByTestId("repo-catalog-ok")).toBeVisible({ timeout: 15_000 });

    // The dialog doesn't auto-close on success (user reviews the confirmation) — its
    // overlay blocks clicks elsewhere on the page until dismissed. It also marks the rest
    // of the page aria-hidden while open (Radix modal Dialog), so role-based locators like
    // getByRole("row", ...) can't find the new row until the dialog is closed.
    await page.getByTestId("dialog-close").click();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();

    const row = page.getByRole("row", { name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("link").click();
    await expect(page).toHaveURL(/\/repositories\/[^/]+$/);
    await expect(page.getByTestId("repository-detail-id")).toHaveText(name);
    await page.getByTestId("tab-settings").click();
    await expect(page.getByTestId("repository-detail-path")).toHaveText(`/tmp/${name}`);
  });

  test("unknown repository id shows a not-found state", async ({ page }) => {
    await page.goto("/repositories/does-not-exist-xyz");
    await expect(page.getByTestId("page-repository-detail-not-found")).toBeVisible();
  });
});
