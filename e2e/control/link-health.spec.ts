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

  test("a slow nav menu navigation shows a loading state at once", async ({ page }) => {
    // Sibling routes share /settings, so the root loading.tsx cannot cover the click; a
    // loading.tsx at or below /settings must. The nav link's prefetch delivers it.
    await page.goto("/settings/account");
    await expectPageLoaded(page);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    // Next prefetches the route tree (`next-router-segment-prefetch: /_tree`) and then
    // the segment data that carries the skeleton; wait for the latter.
    const prefetched = page.waitForResponse((r) => {
      const headers = r.request().headers();
      return (
        new URL(r.url()).pathname === "/settings/slack" &&
        headers["next-router-prefetch"] === "1" &&
        headers["next-router-segment-prefetch"] === undefined
      );
    });
    await page.route(
      (url) => url.pathname === "/settings/slack",
      async (route) => {
        const headers = route.request().headers();
        if (headers.rsc === "1" && headers["next-router-prefetch"] !== "1") await held;
        await route.continue();
      },
    );
    await page.getByTestId("nav-group-settings").click();
    await prefetched;
    await page.getByTestId("nav-slack").click();
    await expect(page.getByTestId("app-main").locator('[aria-busy="true"]')).toBeVisible();
    release();
    await expect(page).toHaveURL((url) => url.pathname === "/settings/slack");
    await expectPageLoaded(page);
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
        // Tabs render their own links (e.g. worktree Settings holds the repository and
        // host links), so scan every tab, not just the default one.
        for (const path of detailPages.values()) {
          await checkLinksOn(path);
          const tabHrefs = (await internalLinks(page)).filter((href) =>
            href.startsWith(`${path}?tab=`),
          );
          for (const tabHref of tabHrefs) await checkLinksOn(tabHref);
        }
      } finally {
        await removeHostRepo(request, repoId);
        await request.delete(`/api/v1/repositories/${repoId}`);
      }
    });
  });
});
