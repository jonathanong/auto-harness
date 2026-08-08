import { test, expect } from "@playwright/test";

const API = "http://127.0.0.1:7430";

test.describe("control plane provider account scope overrides", () => {
  test("disable at repo scope, then re-enable and override the command at worktree scope, then reset", async ({
    page,
    request,
  }) => {
    const hostId = `pw-overrides-${test.info().parallelIndex}-${Date.now()}`;
    const repoName = `pw-overrides-repo-${test.info().parallelIndex}-${Date.now()}`;
    const worktreeId = `wt-${test.info().parallelIndex}-${Date.now()}`;
    const providerName = `pw-ov-${test.info().parallelIndex}-${Date.now()}`;

    // Catalog repository ids are always auto-generated (never client-supplied) — create it
    // first and reuse the id it's given for the host-inventory repository entry below, so
    // both sides refer to the same repository.
    const catalogRepo = await (
      await request.post(`${API}/api/v1/repositories`, {
        data: { name: repoName, url: `/tmp/${repoName}`, defaultBranch: "main" },
      })
    ).json();
    const repoId = catalogRepo.id as string;

    const provider = await (
      await request.post(`${API}/api/v1/providers`, { data: { name: providerName } })
    ).json();
    const defaultCommand = await (
      await request.post(`${API}/api/v1/commands`, {
        data: {
          name: `${providerName}-default`,
          argv: ["echo", "default"],
          providerId: provider.id,
        },
      })
    ).json();
    await request.patch(`${API}/api/v1/providers/${provider.id}`, {
      data: { defaultCommandId: defaultCommand.id },
    });
    await request.post(`${API}/api/v1/commands`, {
      data: { name: `${providerName}-alt`, argv: ["echo", "alt"], providerId: provider.id },
    });
    const account = await (
      await request.post(`${API}/api/v1/provider-accounts`, {
        data: { providerId: provider.id, label: `${providerName}@example.com` },
      })
    ).json();

    await request.put(`${API}/api/v1/agents/${hostId}/config`, {
      data: {
        repositories: [
          {
            id: repoId,
            path: `/tmp/${repoId}`,
            defaultBranch: "main",
            worktrees: [
              {
                id: worktreeId,
                name: worktreeId,
                path: `/tmp/${repoId}/${worktreeId}`,
                labels: [],
              },
            ],
          },
        ],
        providerAccounts: [{ providerAccountId: account.id }],
        commandProfiles: {},
      },
    });

    // Disable at repository scope.
    await page.goto(`/repositories/${repoId}?tab=provider-accounts`);
    await expect(page.getByTestId("repository-provider-accounts-tab")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId(`repository-provider-accounts-host-${hostId}`)).toBeVisible();
    await expect(page.getByTestId("provider-scope-table")).toBeVisible();
    const repoRow = page.getByTestId(`provider-scope-row-${account.id}`);
    await expect(repoRow).toBeVisible({ timeout: 15_000 });
    await expect(repoRow).toContainText(`${providerName}-default`);
    await expect(page.getByTestId(`scope-provider-enabled-form-${account.id}`)).toBeVisible();
    await expect(page.getByTestId(`scope-provider-command-form-${account.id}`)).toBeVisible();
    await page
      .getByTestId(`scope-provider-enabled-select-${account.id}`)
      .selectOption({ label: "Disabled" });
    await page.getByTestId(`scope-provider-enabled-submit-${account.id}`).click();
    await expect(page.getByTestId(`provider-scope-inherited-${account.id}`)).toHaveText(
      "repository",
      { timeout: 15_000 },
    );

    // Worktree inherits the repo-level disable.
    await page.goto(`/worktrees/${worktreeId}?tab=provider-accounts`);
    const wtRow = page.getByTestId(`provider-scope-row-${account.id}`);
    await expect(wtRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`scope-provider-enabled-select-${account.id}`)).toHaveValue("");
    await expect(page.getByTestId(`provider-scope-inherited-${account.id}`)).toHaveText(
      "repository",
    );

    // Re-enable and override the command at worktree scope — wins over the repo disable.
    await page
      .getByTestId(`scope-provider-enabled-select-${account.id}`)
      .selectOption({ label: "Enabled" });
    await page.getByTestId(`scope-provider-enabled-submit-${account.id}`).click();
    await expect(page.getByTestId(`provider-scope-inherited-${account.id}`)).toHaveText(
      "this worktree",
      { timeout: 15_000 },
    );
    await page
      .getByTestId(`scope-provider-command-select-${account.id}`)
      .selectOption({ label: `${providerName}-alt` });
    await page.getByTestId(`scope-provider-command-submit-${account.id}`).click();
    await expect(page.getByTestId(`provider-scope-effective-command-${account.id}`)).toHaveText(
      `${providerName}-alt`,
      { timeout: 15_000 },
    );

    // Reset the worktree's enabled override back to inherited (from the still-disabled repo).
    await page
      .getByTestId(`scope-provider-enabled-select-${account.id}`)
      .selectOption({ label: "(inherit from repository)" });
    await page.getByTestId(`scope-provider-enabled-submit-${account.id}`).click();
    await expect(page.getByTestId(`provider-scope-inherited-${account.id}`)).toHaveText(
      "repository",
      { timeout: 15_000 },
    );
  });

  test("worktree with no host-attached provider accounts shows the empty state", async ({
    page,
    request,
  }) => {
    const hostId = `pw-overrides-empty-${test.info().parallelIndex}-${Date.now()}`;
    const worktreeId = `wt-${test.info().parallelIndex}-${Date.now()}`;
    await request.put(`${API}/api/v1/agents/${hostId}/config`, {
      data: {
        repositories: [
          {
            id: "repo-empty",
            path: "/tmp/repo-empty",
            defaultBranch: "main",
            worktrees: [
              {
                id: worktreeId,
                name: worktreeId,
                path: `/tmp/repo-empty/${worktreeId}`,
                labels: [],
              },
            ],
          },
        ],
        providerAccounts: [],
        commandProfiles: {},
      },
    });

    await page.goto(`/worktrees/${worktreeId}?tab=provider-accounts`);
    await expect(page.getByTestId("provider-scope-table-empty")).toBeVisible({ timeout: 15_000 });
  });
});
