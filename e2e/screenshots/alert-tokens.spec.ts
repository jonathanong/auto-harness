import { expect, test } from "@playwright/test";

import { CONTROL_BASE, shot } from "./lib.ts";

/**
 * Design-review findings #9/#10: nine hand-rolled alert banners across five raw-literal color
 * recipes collapsed into one `Alert` primitive (`modules/ui/src/components/alert.tsx`) driven by
 * `--success/--warning/--danger/--info` CSS-variable tokens. This proves the migration renders —
 * same warning/danger visual language, now token-backed instead of copy-pasted Tailwind literals.
 * Mirrors the route-interception setup from `e2e/control/dashboard.spec.ts`'s
 * "keeps the last snapshot visible when live updates pause" test.
 */
test.describe("alert tokens", () => {
  test("renders the warning and danger Alert variants across the dashboard and sessions list", async ({
    page,
  }) => {
    await page.route("**/api/v1/sessions**", async (route) => {
      await route.fulfill({ status: 503, json: { error: "offline" } });
    });
    await page.route("**/api/v1/hosts", async (route) => {
      await route.fulfill({ status: 503, json: { error: "offline" } });
    });
    await page.route("**/api/v1/worktrees", async (route) => {
      await route.fulfill({ status: 503, json: { error: "offline" } });
    });

    await page.goto(`${CONTROL_BASE}/`);
    await expect(page.getByTestId("live-updates-paused")).toBeVisible({ timeout: 10_000 });
    await shot(page, "alert-tokens-dashboard");

    await page.goto(`${CONTROL_BASE}/sessions`);
    await expect(page.getByTestId("sessions-live-error")).toBeVisible({ timeout: 10_000 });
    await shot(page, "alert-tokens-sessions");
  });
});
