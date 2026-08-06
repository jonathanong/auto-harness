import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";

test.describe("control plane worktrees", () => {
  test("worktrees page loads", async ({ page }) => {
    await page.goto("/worktrees");
    await expect(page.getByTestId("page-worktrees")).toBeVisible();
    await expect(page.getByTestId("worktrees-heading")).toHaveText("Worktrees");
  });

  test("unknown worktree id shows a not-found state", async ({ page }) => {
    await page.goto("/worktrees/does-not-exist-xyz");
    await expect(page.getByTestId("page-worktree-detail-not-found")).toBeVisible();
  });

  test("clicking a worktree opens its fleet-wide detail page", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const repoId = `pw-ctl-wt-repo-${test.info().parallelIndex}-${Date.now()}`;
      const wtId = `wt-${test.info().parallelIndex}-${Date.now()}`;
      const wtPath = `/tmp/${repoId}/${wtId}`;

      await putHostRepo(request, {
        id: repoId,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [{ id: wtId, name: wtId, path: wtPath, labels: ["echo"] }],
      });

      try {
        await page.goto("/worktrees");
        await expect(page.getByTestId(`worktree-link-${wtId}`)).toBeVisible({ timeout: 15_000 });
        await page.getByTestId(`worktree-link-${wtId}`).click();

        await expect(page).toHaveURL(new RegExp(`/worktrees/${wtId}$`));
        await expect(page.getByTestId("worktree-detail-id")).toHaveText(wtId);
        await page.getByTestId("tab-settings").click();
        await expect(page.getByTestId("worktree-detail-path")).toHaveText(wtPath);
      } finally {
        await removeHostRepo(request, repoId);
      }
    });
  });
});
