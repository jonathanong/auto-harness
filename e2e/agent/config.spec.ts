import { test, expect } from "@playwright/test";

test.describe("agent pane config", () => {
  test("config page shows inventory editor and raw JSON", async ({ page }) => {
    await page.goto("/config");
    await expect(page.getByTestId("page-agent-config")).toBeVisible();
    await expect(page.getByTestId("agent-config-heading")).toBeVisible();
    await expect(page.getByTestId("host-inventory-editor")).toBeVisible();
    await expect(page.getByTestId("form-add-local-repo")).toBeVisible();
    await expect(page.getByTestId("add-repo-path")).toBeVisible();
    await expect(page.getByTestId("form-host-config-json")).toBeVisible();
    await expect(page.getByTestId("host-config-json")).toBeVisible();
  });

  test("add repository without inventing worktrees", async ({ page }) => {
    const id = `pw-agent-repo-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/config");
    await page.getByTestId("add-repo-id").fill(id);
    await page.getByTestId("add-repo-name").fill(id);
    await page.getByTestId("add-repo-path").fill(`/tmp/${id}`);
    await page.getByTestId("add-repo-submit").click();
    await expect(page.getByTestId("add-repo-ok")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`repo-card-${id}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No worktrees yet")).toBeVisible();
  });

  test("add explicit worktree under a repository", async ({ page }) => {
    const id = `pw-agent-repo-wt-${test.info().parallelIndex}-${Date.now()}`;
    const wtId = `runner-${test.info().parallelIndex}`;
    await page.goto("/config");
    await page.getByTestId("add-repo-id").fill(id);
    await page.getByTestId("add-repo-path").fill(`/tmp/${id}`);
    await page.getByTestId("add-repo-submit").click();
    await expect(page.getByTestId(`repo-card-${id}`)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId(`add-worktree-open-${id}`).click();
    await page.getByTestId(`add-worktree-id-${id}`).fill(wtId);
    await page.getByTestId(`add-worktree-path-${id}`).fill(`/tmp/${id}/work/${wtId}`);
    await page.getByTestId(`add-worktree-submit-${id}`).click();
    await expect(page.getByTestId(`worktree-row-${wtId}`)).toBeVisible({ timeout: 15_000 });
  });
});
