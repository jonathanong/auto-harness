import { test, expect } from "@playwright/test";

test.describe("control plane dashboard", () => {
  test("loads shell and dashboard stats", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("control-shell")).toBeVisible();
    await expect(page.getByTestId("page-dashboard")).toBeVisible();
    await expect(page.getByTestId("dashboard-heading")).toHaveText("Dashboard");
    await expect(page.getByTestId("dashboard-stats")).toBeVisible();
    await expect(page.getByTestId("stat-running")).toBeVisible();
    await expect(page.getByTestId("stat-running-value")).toBeVisible();
    await expect(page.getByTestId("stat-queued")).toBeVisible();
    await expect(page.getByTestId("stat-queued-value")).toBeVisible();
    await expect(page.getByTestId("stat-hosts-online")).toBeVisible();
    await expect(page.getByTestId("stat-hosts-online-value")).toBeVisible();
    await expect(page.getByTestId("stat-worktree-utilization-value")).toBeVisible();
    await expect(page.getByTestId("live-updates-active")).toBeVisible();
    await expect(page.getByTestId("dashboard-no-online-hosts")).toBeVisible();
    await expect(page.getByTestId("dashboard-recent-sessions")).toBeVisible();
  });

  test("refreshes dashboard and session list from bounded production polling", async ({ page }) => {
    await page.goto("/");
    await page.route("**/api/v1/sessions", async (route) => {
      await route.fulfill({ json: { items: [{ id: "live-dashboard", status: "running" }] } });
    });
    await page.route("**/api/v1/hosts", async (route) => {
      await route.fulfill({ json: { items: [{ hostId: "live-host", online: true }] } });
    });
    await page.route("**/api/v1/worktrees", async (route) => {
      await route.fulfill({ json: { items: [{ id: "busy", status: "busy", online: true }] } });
    });
    await page.route("**/api/v1/sessions?status=running&limit=100", async (route) => {
      await route.fulfill({ json: { items: [{ id: "live-dashboard" }], nextCursor: null } });
    });
    await page.route("**/api/v1/sessions?status=queued&limit=100", async (route) => {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    });
    await expect(page.getByTestId("stat-running-value")).toHaveText("1", { timeout: 10_000 });
    await expect(page.getByTestId("stat-worktree-utilization-value")).toHaveText("1/1 busy");

    await page.goto("/sessions");
    await page.route("**/api/v1/sessions**", async (route) => {
      await route.fulfill({
        json: { items: [{ id: "live-list", status: "queued" }], nextCursor: null },
      });
    });
    await expect(page.getByTestId("session-row-live-list")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("sessions-live-active")).toBeVisible();
  });

  test("keeps the last snapshot visible when live updates pause", async ({ page }) => {
    await page.route("**/api/v1/sessions**", async (route) => {
      await route.fulfill({ status: 503, json: { error: "offline" } });
    });
    await page.route("**/api/v1/hosts", async (route) => {
      await route.fulfill({ status: 503, json: { error: "offline" } });
    });
    await page.route("**/api/v1/worktrees", async (route) => {
      await route.fulfill({ status: 503, json: { error: "offline" } });
    });

    await page.goto("/");
    await expect(page.getByTestId("live-updates-paused")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("dashboard-stats")).toBeVisible();

    await page.goto("/sessions");
    await expect(page.getByTestId("sessions-live-error")).toBeVisible({ timeout: 10_000 });
  });

  test("nav links are present", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("nav-session-new")).toBeVisible();

    await page.getByTestId("nav-group-operate").click();
    await expect(page.getByTestId("nav-dashboard")).toBeVisible();
    await expect(page.getByTestId("nav-sessions")).toBeVisible();
    await expect(page.getByTestId("nav-schedules")).toBeVisible();

    await page.getByTestId("nav-group-catalog").click();
    await expect(page.getByTestId("nav-repositories")).toBeVisible();

    await page.getByTestId("nav-group-fleet").click();
    await expect(page.getByTestId("nav-worktrees")).toBeVisible();
    await expect(page.getByTestId("nav-hosts")).toBeVisible();
  });
});
