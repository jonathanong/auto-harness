import { test, expect } from "@playwright/test";

test.describe("control plane repositories", () => {
  test("repository hierarchy shows the branch and copies the exact Git URL", async ({
    page,
    request,
    context,
  }) => {
    const name = `pw-repo-branch-${test.info().parallelIndex}-${Date.now()}`;
    const url = `https://git.example.test/${name}/a-very-long-repository-name.git`;
    const response = await request.post("/api/v1/repositories", {
      data: { name, url, defaultBranch: "trunk" },
    });
    expect(response.ok()).toBe(true);
    const repositoryId = ((await response.json()) as { id: string }).id;

    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/repositories");
      const branch = page.getByTestId(`repo-default-branch-${repositoryId}`);
      await expect(branch).toHaveText("Default branch: trunk");
      await expect(page.getByTestId(`repo-count-sessions-${repositoryId}`)).toHaveText("Sessions0");
      await expect(page.getByTestId(`repo-count-worktrees-${repositoryId}`)).toHaveText(
        "Worktrees0",
      );
      await expect(page.getByTestId(`repo-count-schedules-${repositoryId}`)).toHaveText(
        "Schedules0",
      );
      await expect(page.getByTestId(`repository-url-${repositoryId}`)).toHaveText(url);
      await expect(page.getByTestId(`repository-url-${repositoryId}`)).toHaveAttribute(
        "title",
        url,
      );
      await page.getByTestId(`repository-url-copy-${repositoryId}`).click();
      await expect(page.getByTestId(`repository-url-copy-${repositoryId}`)).toHaveText("Copied");
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);

      await page.goto(`/repositories/${repositoryId}?tab=worktrees`);
      await expect(page.getByTestId(`repository-url-${repositoryId}`)).toHaveText(url);
      await expect(page.getByTestId(`repository-url-copy-${repositoryId}`)).toBeVisible();
    } finally {
      await request.delete(`/api/v1/repositories/${repositoryId}`);
    }
  });

  test("repositories page loads with add-repository dialog closed", async ({ page }) => {
    await page.goto("/repositories");
    await expect(
      page.getByTestId("page-repositories").or(page.getByTestId("repositories-loading")).first(),
    ).toBeVisible();
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

  test("create catalog repository via modal, then land on its detail page", async ({ page }) => {
    // Name must be a lowercase-dash slug — id is now auto-generated, never typed.
    const name = `pw-repo-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/repositories");
    await page.getByTestId("add-repo-open").click();
    await expect(page.getByTestId("form-repo-catalog")).toBeVisible();
    await expect(page.getByTestId("repo-catalog-branch")).toHaveValue("main");
    await expect(page.getByTestId("repo-catalog-setup")).toHaveValue("");
    await expect(page.getByTestId("repo-catalog-error")).toBeHidden();
    await page.getByTestId("repo-catalog-name").fill(name);
    await page.getByTestId("repo-catalog-url").fill(`/tmp/${name}`);
    await page.getByTestId("repo-catalog-setup").fill("pnpm install\npnpm build");
    await page.getByTestId("repo-catalog-submit").click();

    // Success navigates straight to the new repo's detail page (toast + navigate) —
    // no inline confirmation to dismiss first.
    await expect(page).toHaveURL(/\/repositories\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByTestId("repository-detail-id")).toHaveText(name);
    await page.getByTestId("tab-settings").click();
    await expect(page.getByTestId("page-repository-detail")).toBeVisible();
    await expect(page.getByTestId("repository-settings")).toBeVisible();
    await expect(page.getByTestId("repository-attached-hosts")).toHaveCount(0);
    await expect(page.getByTestId("repository-detail-path")).toHaveText(`/tmp/${name}`);
    await page.getByTestId("edit-repo-open").click();
    await expect(page.getByTestId("form-edit-repo")).toBeVisible();
    await expect(page.getByTestId("edit-repo-url")).toHaveValue(`/tmp/${name}`);
    await expect(page.getByTestId("edit-repo-branch")).toHaveValue("main");
    await expect(page.getByTestId("edit-repo-setup")).toBeVisible();
    await expect(page.getByTestId("edit-repo-setup")).toHaveValue("pnpm install\npnpm build");
    await expect(page.getByTestId("edit-repo-hook")).toBeVisible();
    await expect(page.getByTestId("edit-repo-error")).toBeHidden();
    await page.getByTestId("edit-repo-submit").click();
    await expect(page.getByTestId("form-edit-repo")).toBeHidden({ timeout: 15_000 });
    await page.getByTestId("delete-repo-open").click();
    await expect(page.getByTestId("delete-repo-confirm")).toBeVisible();
    await expect(page.getByTestId("delete-repo-error")).toBeHidden();
    await page.getByTestId("delete-repo-confirm-submit").click();
    await expect(page).toHaveURL(/\/repositories$/, { timeout: 15_000 });
  });

  test("unknown repository id shows a not-found state", async ({ page }) => {
    await page.goto("/repositories/does-not-exist-xyz");
    await expect(page.getByTestId("page-repository-detail-not-found")).toBeVisible();
  });

  test("attach form exposes host, repository, path, and branch controls", async ({
    page,
    request,
  }) => {
    const hostId = `pw-attach-host-${test.info().parallelIndex}-${Date.now()}`;
    const repoName = `pw-attach-repo-${test.info().parallelIndex}-${Date.now()}`;
    const repo = await (
      await request.post("/api/v1/repositories", {
        data: { name: repoName, url: `/tmp/${repoName}`, defaultBranch: "main" },
      })
    ).json();
    const repoId = repo.id as string;
    await request.put(`/api/v1/hosts/${hostId}/inventory`, {
      data: { repositories: [], providerAccounts: [], commandProfiles: {} },
    });

    try {
      await page.goto("/repositories");
      await expect(page.getByTestId("form-attach-local-repo")).toBeVisible();
      await page.getByTestId("attach-repo-agent-id").selectOption(hostId);
      await page.getByTestId("attach-repo-catalog-id").selectOption(repoId);
      await expect(page.getByTestId("attach-repo-agent-id")).toHaveValue(hostId);
      await expect(page.getByTestId("attach-repo-catalog-id")).toHaveValue(repoId);
      await expect(page.getByTestId("attach-repo-path")).toBeVisible();
      await expect(page.getByTestId("attach-repo-branch")).toHaveValue("main");
      await expect(page.getByTestId("attach-repo-error")).toBeHidden();
      await page.getByTestId("attach-repo-path").fill(`/tmp/${repoName}`);
      await page.getByTestId("attach-repo-submit").click();
      await expect(page).toHaveURL(new RegExp(`/repositories/${repoId}$`), { timeout: 15_000 });
    } finally {
      await request.put(`/api/v1/hosts/${hostId}/inventory`, {
        data: { repositories: [], providerAccounts: [], commandProfiles: {} },
      });
      await request.delete(`/api/v1/repositories/${repoId}`);
    }
  });
});
