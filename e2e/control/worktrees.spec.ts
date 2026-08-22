import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";
import { API_BASE } from "../harness-endpoints.ts";

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
      const createdName = `created-${test.info().parallelIndex}-${Date.now()}`;
      const wtPath = `/tmp/${repoId}/${wtId}`;

      await putHostRepo(request, {
        id: repoId,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [
          {
            id: wtId,
            name: wtId,
            path: wtPath,
            labels: ["echo"],
            setupScript: "old setup",
          },
        ],
      });

      try {
        await page.goto("/worktrees");
        await expect(page.getByTestId(`worktree-link-${wtId}`)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId(`add-worktree-for-repo-${repoId}`)).toBeVisible();
        await expect(page.getByTestId(`add-worktree-open-${repoId}`)).toBeVisible();
        await expect(page.getByTestId(`add-worktree-host-${repoId}`)).toHaveCount(0);
        await expect(page.getByTestId(`add-worktree-need-host-${repoId}`)).toHaveCount(0);
        await page.getByTestId(`add-worktree-open-${repoId}`).click();
        await page.getByTestId(`add-worktree-name-${repoId}`).fill(createdName);
        await page.getByTestId(`add-worktree-setup-script-${repoId}`).fill("pnpm install");
        await page.getByTestId(`add-worktree-submit-${repoId}`).click();
        await expect(page.getByTestId(`form-add-worktree-${repoId}`)).toBeHidden({
          timeout: 15_000,
        });
        const inventory = await (
          await request.get(`${API_BASE}/api/v1/hosts/local-1/inventory`)
        ).json();
        expect(
          inventory.repositories
            .find((repository: { id: string }) => repository.id === repoId)
            ?.worktrees.find((worktree: { name: string }) => worktree.name === createdName),
        ).toMatchObject({ setupScript: "pnpm install" });
        await expect(page.getByTestId(`worktree-labels-${wtId}`)).toHaveText("echo");
        await page.getByTestId(`worktree-link-${wtId}`).click();

        await expect(page).toHaveURL(new RegExp(`/worktrees/${wtId}$`));
        await expect(page.getByTestId("page-worktree-detail")).toBeVisible();
        await expect(page.getByTestId("worktree-detail-id")).toHaveText(wtId);
        await page.getByTestId("tab-settings").click();
        await expect(page.getByTestId("worktree-detail-path")).toHaveText(wtPath);
        await expect(page.getByTestId(`worktree-labels-${wtId}`)).toHaveText("echo");
        await page.getByTestId("worktree-edit-open").click();
        await expect(page.getByTestId("edit-worktree-dialog")).toBeVisible();
        await expect(page.getByTestId("form-edit-worktree")).toBeVisible();
        await expect(page.getByTestId("worktree-edit-path")).toHaveValue(wtPath);
        await expect(page.getByTestId("worktree-edit-labels")).toHaveValue("echo");
        await expect(page.getByTestId("worktree-edit-setup-script")).toHaveValue("old setup");
        await expect(page.getByTestId("worktree-edit-error")).toBeHidden();
        await page.getByTestId("worktree-edit-labels").fill("");
        await page.getByTestId("worktree-edit-setup-script").fill("pnpm build");
        await page.getByTestId("worktree-edit-submit").click();
        await expect(page.getByTestId("form-edit-worktree")).toBeHidden({ timeout: 15_000 });
        await expect(page.getByTestId(`worktree-labels-${wtId}`)).toHaveText("—", {
          timeout: 15_000,
        });
        await page.getByTestId("worktree-edit-open").click();
        await expect(page.getByTestId("worktree-edit-labels")).toHaveValue("");
        await expect(page.getByTestId("worktree-edit-setup-script")).toHaveValue("pnpm build");
      } finally {
        await removeHostRepo(request, repoId);
      }
    });
  });
});
