import { test, expect } from "@playwright/test";

test.describe("host pane repositories", () => {
  test("repositories page loads with add-repository dialog closed", async ({ page }) => {
    await page.goto("/repositories");
    await expect(page.getByTestId("page-repositories")).toBeVisible();
    await expect(page.getByTestId("repositories-heading")).toHaveText("Repositories");
    await expect(page.getByTestId("add-repo-open")).toBeVisible();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();
  });

  test("add repository via modal, nested worktrees section shows it empty", async ({ page }) => {
    const id = `pw-agent-repo-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/repositories");

    await page.getByTestId("add-repo-open").click();
    await expect(page.getByTestId("add-repo-dialog")).toBeVisible();
    await page.getByTestId("add-repo-id").fill(id);
    await page.getByTestId("add-repo-path").fill(`/tmp/${id}`);
    await page.getByTestId("add-repo-submit").click();
    await expect(page.getByTestId("add-repo-ok")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("dialog-close").click();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();
    await expect(page.getByTestId(`repo-row-${id}`)).toBeVisible({ timeout: 15_000 });

    const group = page.getByTestId(`worktree-group-${id}`);
    await expect(group).toBeVisible();
    await expect(group.getByText("No worktrees under this repository.")).toBeVisible();
  });

  test("clicking a repository opens its detail page; removing redirects back", async ({ page }) => {
    const id = `pw-agent-repo-detail-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/repositories");

    await page.getByTestId("add-repo-open").click();
    await page.getByTestId("add-repo-id").fill(id);
    await page.getByTestId("add-repo-path").fill(`/tmp/${id}`);
    await page.getByTestId("add-repo-submit").click();
    await expect(page.getByTestId("add-repo-ok")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("dialog-close").click();

    await page.getByTestId(`repo-link-${id}`).click();
    await expect(page).toHaveURL(new RegExp(`/repositories/${id}$`));
    await expect(page.getByTestId("repository-detail-id")).toHaveText(id);
    await expect(page.getByTestId("repository-detail-path")).toHaveText(`/tmp/${id}`);

    await page.getByTestId(`repo-remove-${id}`).click();
    await expect(page).toHaveURL(/\/repositories$/, { timeout: 15_000 });
    await expect(page.getByTestId(`repo-row-${id}`)).toHaveCount(0);
  });

  test("unknown repository id shows a not-found state", async ({ page }) => {
    await page.goto("/repositories/does-not-exist-xyz");
    await expect(page.getByTestId("page-repository-detail-not-found")).toBeVisible();
  });
});
