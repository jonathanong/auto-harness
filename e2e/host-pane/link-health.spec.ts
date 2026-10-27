import { test, expect, type Page } from "@playwright/test";

import { expectNoLeakedNextDigest } from "../no-redirect-leak.ts";

/** Route loading skeletons mark themselves aria-busy; wait for the real page body. */
async function expectPageLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId("app-main")).toBeVisible();
  await expect(page.getByTestId("app-main").locator('[aria-busy="true"]')).toHaveCount(0, {
    timeout: 15_000,
  });
}

const NAV: ReadonlyArray<[item: string, path: string]> = [
  ["nav-repositories", "/repositories"],
  ["nav-sessions", "/sessions"],
  ["nav-settings", "/settings"],
];

test.describe("host pane link health", () => {
  test("every nav link navigates to its page", async ({ page }) => {
    await page.goto("/settings");
    for (const [item, path] of NAV) {
      await page.getByTestId(item).click();
      await expect(page, `${item} → ${path}`).toHaveURL((url) => url.pathname === path);
      await expectPageLoaded(page);
      await expectNoLeakedNextDigest(page);
    }
  });

  test("every internal link on top-level pages resolves", async ({ page }) => {
    const checked = new Set<string>();
    for (const [, path] of NAV) {
      await page.goto(path);
      await expectPageLoaded(page);
      const hrefs = await page
        .getByTestId("app-main")
        .locator('a[href^="/"]')
        .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
      for (const href of hrefs) {
        if (href === "" || checked.has(href)) continue;
        checked.add(href);
        const response = await page.request.get(href, { maxRedirects: 0 });
        expect(response.status(), `${href} (linked from ${path})`).toBeLessThan(400);
      }
    }
    expect(checked.size).toBeGreaterThan(0);
  });
});
