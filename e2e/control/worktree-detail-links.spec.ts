import { test, expect, type Page } from "@playwright/test";

import {
  createCatalogRepository,
  putHostRepo,
  removeHostRepo,
  withLocalHostLock,
} from "../local-1-host.ts";

async function expectActiveTab(page: Page, key: string): Promise<void> {
  await expect(page.getByTestId(`tab-${key}`)).toHaveAttribute("aria-selected", "true");
}

test.describe("control plane worktree detail links", () => {
  test("tabs, breadcrumb, repository, and host links navigate", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const suffix = `${test.info().parallelIndex}-${Date.now()}`;
      const repoName = `pw-ctl-wt-links-repo-${suffix}`;
      // Host repo ids are catalog ids in production, so the repository link resolves.
      const repoId = await createCatalogRepository(request, repoName);
      const wtId = `wt-links-${suffix}`;
      const detailPath = `/worktrees/${wtId}`;

      try {
        await putHostRepo(request, {
          id: repoId,
          path: `/tmp/${repoName}`,
          defaultBranch: "main",
          worktrees: [{ id: wtId, name: wtId, path: `/tmp/${repoName}/${wtId}`, labels: [] }],
        });

        await page.goto("/worktrees");
        await expect(page.getByTestId(`worktree-link-${wtId}`)).toBeVisible({ timeout: 15_000 });
        await page.getByTestId(`worktree-link-${wtId}`).click();
        await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
        await expect(page.getByTestId("worktree-detail-id")).toHaveText(wtId);
        await expectActiveTab(page, "sessions");

        await page.getByTestId("tab-provider-accounts").click();
        await expect(page).toHaveURL(new RegExp(`${detailPath}\\?tab=provider-accounts$`));
        await expectActiveTab(page, "provider-accounts");

        await page.getByTestId("tab-settings").click();
        await expect(page).toHaveURL(new RegExp(`${detailPath}\\?tab=settings$`));
        await expectActiveTab(page, "settings");
        await expect(page.getByTestId("worktree-detail-path")).toBeVisible();

        await page.getByTestId("tab-sessions").click();
        await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
        await expectActiveTab(page, "sessions");

        await page.goto(`${detailPath}?tab=settings`);
        await page.getByTestId("worktree-detail-repository-link").click();
        await expect(page).toHaveURL(new RegExp(`/repositories/${repoId}$`));
        await expect(page.getByTestId("page-repository-detail")).toBeVisible();

        await page.goto(`${detailPath}?tab=settings`);
        await page.getByTestId("worktree-detail-host-link").click();
        await expect(page).toHaveURL(/\/hosts\/local-1$/);
        await expect(page.getByTestId("page-host-detail")).toBeVisible();

        await page.goto(`${detailPath}?tab=settings`);
        await expect(page.getByTestId("worktree-detail-path")).toBeVisible();
        await page.getByTestId("breadcrumb-0").click();
        await expect(page).toHaveURL(/\/worktrees$/);
        await expect(page.getByTestId("page-worktrees")).toBeVisible();
      } finally {
        await removeHostRepo(request, repoId);
        await request.delete(`/api/v1/repositories/${repoId}`);
      }
    });
  });
});
