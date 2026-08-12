import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";

test.describe("host pane worktrees", () => {
  test("clicking a worktree opens its detail page; removing redirects back", async ({
    page,
    request,
  }) => {
    await withLocalHostLock(async () => {
      const repoId = `pw-agent-wt-repo-${test.info().parallelIndex}-${Date.now()}`;
      const wtId = `wt-${test.info().parallelIndex}-${Date.now()}`;
      const wtPath = `/tmp/${repoId}/${wtId}`;

      await putHostRepo(request, {
        id: repoId,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [{ id: wtId, name: wtId, path: wtPath, labels: ["echo"] }],
      });

      try {
        // Worktrees are managed from a repository's own detail page (Worktrees tab) — there's
        // no standalone host-pane worktrees list, unlike the control plane's fleet-wide one.
        await page.goto(`/repositories/${repoId}?tab=worktrees`);
        await expect(page.getByTestId(`worktree-link-${wtId}`)).toBeVisible({ timeout: 15_000 });
        await page.getByTestId(`worktree-link-${wtId}`).click();

        await expect(page).toHaveURL(new RegExp(`/worktrees/${wtId}$`));
        await expect(page.getByTestId("page-worktree-detail")).toBeVisible();
        await expect(page.getByTestId("worktree-detail-id")).toHaveText(wtId);
        await page.getByTestId("tab-settings").click();
        await expect(page.getByTestId("worktree-detail-path")).toHaveText(wtPath);

        await page.getByTestId(`worktree-remove-${wtId}`).click();
        await page.getByTestId(`worktree-remove-${wtId}-confirm-submit`).click();
        await expect(page).toHaveURL(new RegExp(`/repositories/${repoId}\\?tab=worktrees$`), {
          timeout: 15_000,
        });
        await expect(page.getByTestId(`worktree-row-${wtId}`)).toHaveCount(0);
      } finally {
        await removeHostRepo(request, repoId);
      }
    });
  });

  test("unknown worktree id shows a not-found state", async ({ page }) => {
    await page.goto("/worktrees/does-not-exist-xyz");
    await expect(page.getByTestId("page-worktree-detail-not-found")).toBeVisible();
  });
});
