import { expect, test } from "@playwright/test";

// Covers the unauthenticated SSR probe (services/web/src/app/health/probe/page.tsx): it
// proves the web Lambda's server-side apiGet() -> apiBase() -> fetch() path reaches the
// real control-plane API end to end, using the actual local e2e API server (no route
// mocking) — the same real transport that silently 403'd during the 2026-09-16 redeploy.
test("the SSR probe route renders the success marker via a real server-side API fetch", async ({
  page,
}) => {
  await page.goto("/health/probe");
  await expect(page.getByTestId("probe-ssr-ok")).toBeVisible();
  await expect(page.getByTestId("probe-ssr-ok")).toHaveText("probe: ok");
});
