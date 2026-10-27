import { test, expect, type Page } from "@playwright/test";

import {
  createCatalogRepository,
  putHostRepo,
  removeHostRepo,
  withLocalHostLock,
} from "../local-1-host.ts";
import { expectNoLeakedNextDigest } from "../no-redirect-leak.ts";

// Every nav menu item, grouped by the dropdown that holds it.
const NAV: ReadonlyArray<[group: string, item: string, path: string]> = [
  ["nav-group-operate", "nav-dashboard", "/"],
  ["nav-group-operate", "nav-sessions", "/sessions"],
  ["nav-group-operate", "nav-user-sessions", "/user-sessions"],
  ["nav-group-operate", "nav-schedules", "/schedules"],
  ["nav-group-catalog", "nav-repositories", "/repositories"],
  ["nav-group-catalog", "nav-providers", "/providers"],
  ["nav-group-catalog", "nav-commands", "/commands"],
  ["nav-group-fleet", "nav-worktrees", "/worktrees"],
  ["nav-group-fleet", "nav-hosts", "/hosts"],
  ["nav-group-fleet", "nav-workspace-pools", "/workspace-pools"],
  ["nav-group-settings", "nav-settings", "/settings/account"],
  ["nav-group-settings", "nav-user-accounts", "/settings/user-accounts"],
  ["nav-group-settings", "nav-service-accounts", "/settings/service-accounts"],
  ["nav-group-settings", "nav-slack", "/settings/slack"],
  ["nav-group-settings", "nav-custom-webhooks", "/settings/custom-webhooks"],
  ["nav-group-settings", "nav-github-ingress", "/settings/github-ingress"],
  ["nav-group-settings", "nav-session-log-settings", "/settings/session-logs"],
];

/** Route loading skeletons mark themselves aria-busy; wait for the real page body. */
async function expectPageLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId("app-main")).toBeVisible();
  await expect(page.getByTestId("app-main").locator('[aria-busy="true"]')).toHaveCount(0, {
    timeout: 15_000,
  });
}

/** Same-origin hrefs rendered in the page body, without hash-only or auth links. */
async function internalLinks(page: Page): Promise<string[]> {
  const hrefs = await page
    .getByTestId("app-main")
    .locator('a[href^="/"]')
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
  return hrefs.filter((href) => href !== "" && !href.startsWith("/login"));
}

test.describe("control plane link health", () => {
  test("every nav menu item navigates to its page", async ({ page }) => {
    await page.goto("/worktrees");
    for (const [group, item, path] of NAV) {
      await page.getByTestId(group).click();
      await page.getByTestId(item).click();
      await expect(page, `${item} → ${path}`).toHaveURL((url) => url.pathname === path);
      await expectPageLoaded(page);
      await expectNoLeakedNextDigest(page);
    }
  });

  test("every internal link on top-level and detail pages resolves", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      // Seed a repository + worktree so list pages render detail links to check.
      const suffix = `${test.info().parallelIndex}-${Date.now()}`;
      const repoName = `pw-link-health-${suffix}`;
      const repoId = await createCatalogRepository(request, repoName);
      const wtId = `wt-link-health-${suffix}`;
      try {
        await putHostRepo(request, {
          id: repoId,
          path: `/tmp/${repoName}`,
          defaultBranch: "main",
          worktrees: [{ id: wtId, name: wtId, path: `/tmp/${repoName}/${wtId}`, labels: [] }],
        });
        await page.goto("/worktrees");
        await expect(page.getByTestId(`worktree-link-${wtId}`)).toBeVisible({ timeout: 15_000 });

        const checked = new Set<string>();
        const checkLinksOn = async (path: string) => {
          await page.goto(path);
          await expectPageLoaded(page);
          const hrefs = await internalLinks(page);
          test.info().annotations.push({ type: "links", description: `${path}: ${hrefs.length}` });
          for (const href of hrefs) {
            if (checked.has(href)) continue;
            checked.add(href);
            const response = await page.request.get(href, { maxRedirects: 0 });
            expect(response.status(), `${href} (linked from ${path})`).toBeLessThan(400);
          }
        };
        for (const [, , path] of NAV) await checkLinksOn(path);
        expect([...checked]).toEqual(
          expect.arrayContaining([`/repositories/${repoId}`, `/worktrees/${wtId}`]),
        );

        // One level deeper: visit one detail page per route and check its links
        // (tabs, breadcrumbs, cross-links), which top-level pages never render.
        const navPaths = new Set(NAV.map(([, , path]) => path));
        const detailPages = new Map<string, string>();
        for (const href of checked) {
          const { pathname } = new URL(href, "http://x");
          const route = pathname.replace(/\/[^/]+$/, "/:id");
          if (navPaths.has(pathname) || route === "/:id" || detailPages.has(route)) continue;
          detailPages.set(route, pathname);
        }
        expect([...detailPages.keys()]).toEqual(
          expect.arrayContaining(["/repositories/:id", "/worktrees/:id"]),
        );
        for (const path of detailPages.values()) await checkLinksOn(path);
      } finally {
        await removeHostRepo(request, repoId);
        await request.delete(`/api/v1/repositories/${repoId}`);
      }
    });
  });
});
