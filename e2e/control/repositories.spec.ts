import { test, expect } from "@playwright/test";

test.describe("control plane repositories", () => {
  test("repositories page loads with add-repository dialog closed", async ({ page }) => {
    await page.goto("/repositories");
    await expect(page.getByTestId("page-repositories")).toBeVisible();
    await expect(page.getByTestId("repositories-heading")).toHaveText("Repositories");
    await expect(page.getByTestId("add-repo-open")).toBeVisible();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();
    // The hierarchy only renders once the catalog is non-empty; a genuinely fresh
    // environment (e.g. a clean CI run with no prior test having created a repo yet)
    // shows the empty-state message instead — both are a valid "page loaded" outcome.
    await expect(
      page.getByTestId("worktrees-hierarchy").or(page.getByTestId("worktrees-empty")),
    ).toBeVisible();
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
    // of the page aria-hidden while open (Radix modal Dialog), so role-based locators
    // can't find anything behind it until the dialog is closed.
    await page.getByTestId("dialog-close").click();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();

    // A brand-new repo has no worktrees yet, so it renders as a collapsible group
    // (name link + "no worktrees" message), not a table row.
    const link = page.getByRole("link", { name });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
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
