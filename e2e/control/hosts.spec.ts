import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";

test.describe("control plane hosts", () => {
  test("hosts page loads with filters and add form", async ({ page }) => {
    await page.goto("/hosts");
    await expect(page.getByTestId("page-hosts")).toBeVisible();
    await expect(page.getByTestId("hosts-heading")).toHaveText("Hosts");
    await expect(page.getByTestId("form-add-host")).toBeVisible();
    await expect(page.getByTestId("host-filters")).toBeVisible();
    await page.getByTestId("host-filter-online").selectOption("online");
    await expect(page).toHaveURL(/online=online/);
  });

  test("add host creates empty host inventory slot", async ({ page }) => {
    const id = `pw-host-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/hosts");
    await page.getByTestId("add-host-id").fill(id);
    await page.getByTestId("add-host-submit").click();
    await expect(page.getByTestId("add-host-ok")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-host-error")).toBeHidden();
    await expect(page.getByTestId(`host-row-${id}`)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId(`host-link-${id}`).click();
    await expect(page).toHaveURL(new RegExp(`/hosts/${id}$`));
    await expect(page.getByTestId("page-host-detail")).toBeVisible();
    await expect(page.getByTestId("host-detail-id")).toHaveText(id);
    await expect(page.getByTestId("host-detail-overview")).toBeVisible();
    await expect(page.getByTestId("host-detail-status")).toBeVisible();
    await expect(page.getByTestId("host-detail-repo-count")).toHaveText("0");
    await expect(page.getByTestId("host-detail-worktree-count")).toHaveText("0");
    await page.getByTestId("host-detail-back").click();
    await expect(page.getByTestId("page-hosts")).toBeVisible();

    // Drain is a no-op-safe REST call for an offline slot — just confirm it round-trips.
    await page.getByTestId(`host-drain-${id}`).click();
    await expect(page.getByTestId(`host-drain-${id}`)).toBeEnabled({ timeout: 15_000 });
  });

  test("unknown host id shows a not-found state", async ({ page }) => {
    await page.goto("/hosts/does-not-exist-xyz");
    await expect(page.getByTestId("page-host-detail-not-found")).toBeVisible();
  });

  test("host repository tab exposes attachment settings controls", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const repoId = `pw-host-repo-${test.info().parallelIndex}-${Date.now()}`;
      const repo = await (
        await request.post("http://127.0.0.1:7430/api/v1/repositories", {
          data: { name: repoId, url: `/tmp/${repoId}`, defaultBranch: "main" },
        })
      ).json();
      await putHostRepo(request, {
        id: repo.id,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [],
      });

      try {
        await page.goto("/hosts/local-1?tab=repositories");
        await expect(page.getByTestId("host-repositories-section")).toBeVisible({
          timeout: 15_000,
        });
        await expect(page.getByTestId(`repo-settings-open-${repo.id}`)).toBeVisible();
        await page.getByTestId(`repo-settings-open-${repo.id}`).click();
        await expect(page.getByTestId(`form-repo-settings-${repo.id}`)).toBeVisible();
        await expect(page.getByTestId(`repo-settings-path-${repo.id}`)).toHaveValue(
          `/tmp/${repoId}`,
        );
        await expect(page.getByTestId(`repo-settings-branch-${repo.id}`)).toHaveValue("main");
        await expect(page.getByTestId(`repo-settings-setup-${repo.id}`)).toBeVisible();
        await expect(page.getByTestId(`repo-settings-hook-${repo.id}`)).toBeVisible();
        await expect(page.getByTestId(`repo-settings-error-${repo.id}`)).toHaveCount(0);
        await page.getByTestId(`repo-settings-submit-${repo.id}`).click();
        await expect(page.getByTestId(`repo-settings-open-${repo.id}`)).toBeVisible({
          timeout: 15_000,
        });
      } finally {
        await removeHostRepo(request, repo.id);
        await request.delete(`http://127.0.0.1:7430/api/v1/repositories/${repo.id}`);
      }
    });
  });
});
