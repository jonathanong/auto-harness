import { test, expect } from "@playwright/test";

import { attachRepoViaUi, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";

const API = "http://127.0.0.1:7430";

/** Repositories are created in the catalog first, then attached by reference on a host. */
async function createCatalogRepo(request: import("@playwright/test").APIRequestContext) {
  const name = `pw-agent-repo-${test.info().parallelIndex}-${Date.now()}`;
  const res = await request.post(`${API}/api/v1/repositories`, {
    data: { name, url: `/tmp/${name}` },
  });
  const { id } = (await res.json()) as { id: string; name: string };
  return { id, name };
}

async function deleteCatalogRepo(
  request: import("@playwright/test").APIRequestContext,
  id: string,
) {
  await request.delete(`${API}/api/v1/repositories/${id}`);
}

test.describe("host pane repositories", () => {
  test("repositories page loads with add-repository dialog closed", async ({ page }) => {
    await page.goto("/repositories");
    await expect(page.getByTestId("page-repositories")).toBeVisible();
    await expect(page.getByTestId("repositories-heading")).toHaveText("Repositories");
    await expect(page.getByTestId("add-repo-open")).toBeVisible();
    await expect(page.getByTestId("add-repo-dialog")).toBeHidden();
  });

  test("attach repository via modal, nested worktrees section shows it empty", async ({
    page,
    request,
  }) => {
    await withLocalHostLock(async () => {
      const { id, name } = await createCatalogRepo(request);
      await page.goto("/repositories");

      try {
        await attachRepoViaUi(page, { name, path: `/tmp/${id}` });

        const group = page.getByTestId(`worktree-group-${id}`);
        await expect(group).toBeVisible({ timeout: 15_000 });
        await expect(group.getByText("No worktrees under this repository.")).toBeVisible();
      } finally {
        await removeHostRepo(request, id);
        await deleteCatalogRepo(request, id);
      }
    });
  });

  test("clicking a repository opens its detail page; removing redirects back", async ({
    page,
    request,
  }) => {
    await withLocalHostLock(async () => {
      const { id, name } = await createCatalogRepo(request);
      await page.goto("/repositories");

      try {
        await attachRepoViaUi(page, { name, path: `/tmp/${id}` });

        await page.getByTestId(`repo-link-${id}`).click();
        await expect(page).toHaveURL(new RegExp(`/repositories/${id}$`));
        await expect(page.getByTestId("repository-detail-id")).toHaveText(name);
        await page.getByTestId("tab-settings").click();
        await expect(page.getByTestId("repository-detail-path")).toHaveText(`/tmp/${id}`);

        await page.getByTestId(`repo-remove-${id}`).click();
        await expect(page).toHaveURL(/\/repositories$/, { timeout: 15_000 });
        await expect(page.getByTestId(`worktree-group-${id}`)).toHaveCount(0);
      } finally {
        // Safety net: the UI removal above already deletes it on the happy path, but if an
        // earlier assertion in this test failed first, the repo would otherwise linger.
        await removeHostRepo(request, id);
        await deleteCatalogRepo(request, id);
      }
    });
  });

  test("unknown repository id shows a not-found state", async ({ page }) => {
    await page.goto("/repositories/does-not-exist-xyz");
    await expect(page.getByTestId("page-repository-detail-not-found")).toBeVisible();
  });
});
