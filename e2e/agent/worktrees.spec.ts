import { test, expect } from "@playwright/test";

const API = "http://127.0.0.1:7420";

test.describe("agent pane worktrees", () => {
  test("worktrees page loads", async ({ page }) => {
    await page.goto("/worktrees");
    await expect(page.getByTestId("page-worktrees")).toBeVisible();
    await expect(page.getByTestId("worktrees-heading")).toHaveText("Worktrees");
  });

  test("clicking a worktree opens its detail page; removing redirects back", async ({
    page,
    request,
  }) => {
    const repoId = `pw-agent-wt-repo-${test.info().parallelIndex}-${Date.now()}`;
    const wtId = `wt-${test.info().parallelIndex}-${Date.now()}`;
    const wtPath = `/tmp/${repoId}/${wtId}`;

    const cfgRes = await request.get(`${API}/api/v1/agents/local-1/config`);
    const cfg = cfgRes.ok() ? await cfgRes.json() : { repositories: [], commandProfiles: {} };
    await request.put(`${API}/api/v1/agents/local-1/config`, {
      data: {
        repositories: [
          ...(cfg.repositories ?? []),
          {
            id: repoId,
            path: `/tmp/${repoId}`,
            defaultBranch: "main",
            worktrees: [{ id: wtId, path: wtPath, labels: ["echo"] }],
          },
        ],
        commandProfiles: cfg.commandProfiles ?? {},
      },
    });

    await page.goto("/worktrees");
    await expect(page.getByTestId(`worktree-link-${wtId}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`worktree-link-${wtId}`).click();

    await expect(page).toHaveURL(new RegExp(`/worktrees/${wtId}$`));
    await expect(page.getByTestId("worktree-detail-id")).toHaveText(wtId);
    await expect(page.getByTestId("worktree-detail-path")).toHaveText(wtPath);

    await page.getByTestId(`worktree-remove-${wtId}`).click();
    await expect(page).toHaveURL(/\/worktrees$/, { timeout: 15_000 });
    await expect(page.getByTestId(`worktree-row-${wtId}`)).toHaveCount(0);
  });
});
