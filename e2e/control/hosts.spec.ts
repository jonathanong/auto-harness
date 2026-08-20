import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";
import { API_BASE } from "../harness-endpoints.ts";
import { closeSocket, registerObservedHost } from "../host-websocket-helpers.ts";

test.describe("control plane hosts", () => {
  test("hosts page loads with filters and add form", async ({ page }) => {
    await page.goto("/hosts");
    await expect(page.getByTestId("page-hosts")).toBeVisible();
    await expect(page.getByTestId("hosts-heading")).toHaveText("Hosts");
    await expect(page.getByTestId("form-add-host")).toBeVisible();
    await expect(page.getByTestId("host-filters")).toBeVisible();
    await page.getByTestId("host-filter-online").selectOption("online");
    await expect(page).toHaveURL(/online=online/);
  });

  test("add host creates empty host inventory slot", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = `pw-host-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/hosts");
    await page.getByTestId("add-host-id").fill(id);
    await page.getByTestId("add-host-submit").click();
    await expect(page).toHaveURL((url) => url.pathname === `/hosts/${id}`);
    await expect(page.getByTestId("toast")).toContainText(`Host slot ${id} created.`);
    await expect(page.getByTestId("add-host-error")).toHaveCount(0);
    await expect(page.getByTestId("page-host-detail")).toBeVisible();
    await expect(page.getByTestId("host-detail-id")).toHaveText(id);
    await expect(page.getByTestId("host-detail-overview")).toBeVisible();
    await expect(page.getByTestId("host-detail-status")).toBeVisible();
    await expect(page.getByTestId("host-detail-status")).toHaveText("Offline");
    await expect(page.getByTestId("host-detail-repo-count")).toHaveText("0");
    await expect(page.getByTestId("host-detail-worktree-count")).toHaveText("0");
    await expect(page.getByTestId("host-detail-back")).toHaveAttribute("href", "/hosts");

    // A newly created, still-offline host shows a real, working connect command — not the
    // old flash-then-navigate-away message pointing at a nonexistent `pnpm local:agent`.
    await expect(page.getByTestId("connect-host-panel")).toBeVisible();
    const command = await page.getByTestId("connect-host-command").innerText();
    expect(command).toContain(`HARNESS_HOST_ID='${id}'`);
    expect(command).toContain(`HARNESS_API_URL='${API_BASE}'`);
    expect(command).toContain("pnpm local:daemon start");
    expect(command).not.toContain("local:agent");
    expect(command).not.toContain("execute-api");
    await expect(page.getByTestId("connect-host-panel")).toContainText("two keys");
    await expect(page.getByTestId("connect-host-panel")).toContainText(
      "pnpm local:daemon install-service",
    );
    await page.getByTestId("connect-host-copy").click();
    await expect(page.getByTestId("connect-host-copy")).toHaveText("Copied");
    await expect(page.getByTestId("connect-host-copy-status")).toHaveText("Command copied");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);

    await page.goto("/hosts");
    await expect(page.getByTestId("page-hosts")).toBeVisible();
    await expect(page.getByTestId(`host-row-${id}`)).toBeVisible();
    await expect(page.getByTestId(`host-online-${id}`)).toHaveText("Offline");
    await expect(page.getByTestId("hosts-retained-data-notice")).toBeVisible();
    await expect(page.getByTestId("hosts-retained-data-notice")).toContainText("teardown");
    await expect(page.getByTestId(`host-link-${id}`)).toHaveAttribute(
      "href",
      `/hosts/${encodeURIComponent(id)}`,
    );

    // Drain is a no-op-safe REST call for an offline slot — just confirm it round-trips.
    await page.getByTestId(`host-drain-${id}`).click();
    await expect(page.getByTestId(`host-drain-${id}`)).toBeEnabled({ timeout: 15_000 });
  });

  test("expands connected agent worktree details", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const suffix = `${test.info().parallelIndex}-${Date.now()}`;
      const repositoryId = `pw-fleet-repo-${suffix}`;
      const worktreeId = `pw-fleet-worktree-${suffix}`;
      await putHostRepo(request, {
        id: repositoryId,
        path: `/tmp/${repositoryId}`,
        defaultBranch: "main",
        worktrees: [
          {
            id: worktreeId,
            name: "fleet-feature",
            path: `/tmp/${worktreeId}`,
            labels: ["fleet"],
          },
        ],
      });
      try {
        await page.goto("/hosts");
        await expect(page.getByTestId("host-connected-at-local-1")).toBeVisible();
        const details = page.getByTestId("host-worktrees-local-1");
        await expect(details).toContainText("1 worktree");
        await details.locator("summary").click();
        await expect(page.getByTestId(`host-worktree-link-${worktreeId}`)).toContainText(
          "fleet-feature",
        );
        await expect(details).toContainText("fleet");
        await expect(details).toContainText(`/tmp/${worktreeId}`);
        await expect(details).toContainText(`Repository: ${repositoryId}`);
        await expect(details).toContainText("Current session: None");
      } finally {
        await removeHostRepo(request, repositoryId);
      }
    });
  });

  test("shows durable daemon restart observability", async ({ page }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const hostId = `pw-restart-host-${suffix}`;
    const firstStartedAt = "2026-08-15T12:00:00.000Z";
    const secondStartedAt = "2026-08-15T12:05:00.000Z";
    let socket: WebSocket | undefined;

    try {
      socket = await registerObservedHost(hostId, randomUUID(), firstStartedAt);
      // Restart/connection details live on the host detail page's Overview tab, not the fleet
      // list — the list only needs to say a host is online, not how many times its daemon
      // restarted.
      await page.goto(`/hosts/${hostId}`);
      await expect(page.getByTestId(`host-restart-count-${hostId}`)).toHaveText(
        "0 restarts detected",
      );
      await expect(page.getByTestId(`host-daemon-started-at-${hostId}`)).toHaveAttribute(
        "datetime",
        firstStartedAt,
      );

      await closeSocket(socket);
      socket = await registerObservedHost(hostId, randomUUID(), secondStartedAt);
      await page.reload();
      await expect(page.getByTestId(`host-restart-count-${hostId}`)).toHaveText(
        "1 restart detected",
      );
      await expect(page.getByTestId(`host-daemon-started-at-${hostId}`)).toHaveAttribute(
        "datetime",
        secondStartedAt,
      );
      await expect(page.getByTestId(`host-last-restart-${hostId}`)).toHaveAttribute("datetime");
    } finally {
      if (socket) await closeSocket(socket);
    }
  });

  test("unknown host id shows a not-found state", async ({ page }) => {
    await page.goto("/hosts/does-not-exist-xyz");
    await expect(page.getByTestId("page-host-detail-not-found")).toBeVisible();
  });

  test("host detail Advanced tab saves raw inventory JSON, and surfaces a real version conflict", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const id = `pw-advanced-host-${suffix}`;
    await request.put(`${API_BASE}/api/v1/hosts/${id}/inventory`, {
      data: { repositories: [], providerAccounts: [] },
    });

    await page.goto(`/hosts/${id}?tab=advanced`);
    await expect(page.getByTestId("form-host-config-json")).toBeVisible();
    const textarea = page.getByTestId("host-config-json");
    await expect(textarea).toHaveValue(/"repositories": \[\]/);

    // A real optimistic-concurrency conflict, not a mocked one: this PUT lands after the page
    // above read its version, so the browser's next save is conditioned on a now-stale version.
    await request.put(`${API_BASE}/api/v1/hosts/${id}/inventory`, {
      data: { repositories: [], providerAccounts: [] },
    });

    await page.getByTestId("host-config-submit").click();
    await expect(page.getByTestId("host-config-conflict")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("host-config-conflict")).toContainText(
      "changed since you loaded this page",
    );
    await expect(page.getByTestId("host-config-error")).toHaveCount(0);
    await expect(page.getByTestId("host-config-ok")).toHaveCount(0);

    // Reloading (a fresh version read) lets the same edit save cleanly.
    await page.reload();
    await page.getByTestId("host-config-submit").click();
    await expect(page.getByTestId("host-config-ok")).toHaveText("Saved.", { timeout: 15_000 });
    await expect(page.getByTestId("host-config-conflict")).toHaveCount(0);
  });

  test("host repository tab exposes attachment settings controls", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const repoId = `pw-host-repo-${test.info().parallelIndex}-${Date.now()}`;
      const repo = await (
        await request.post(`${API_BASE}/api/v1/repositories`, {
          data: { name: repoId, url: `/tmp/${repoId}`, defaultBranch: "main" },
        })
      ).json();
      await putHostRepo(request, {
        id: repo.id,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [],
      });

      try {
        await page.goto("/hosts/local-1?tab=repositories");
        await expect(page.getByTestId("host-repositories-section")).toBeVisible({
          timeout: 15_000,
        });
        await expect(page.getByTestId(`repo-settings-open-${repo.id}`)).toBeVisible();
        await page.getByTestId(`repo-settings-open-${repo.id}`).click();
        await expect(page.getByTestId(`form-repo-settings-${repo.id}`)).toBeVisible();
        await expect(page.getByTestId(`repo-settings-path-${repo.id}`)).toHaveValue(
          `/tmp/${repoId}`,
        );
        await expect(page.getByTestId(`repo-settings-branch-${repo.id}`)).toHaveValue("main");
        await expect(page.getByTestId(`repo-settings-setup-${repo.id}`)).toBeVisible();
        await expect(page.getByTestId(`repo-settings-hook-${repo.id}`)).toBeVisible();
        await expect(page.getByTestId(`repo-settings-error-${repo.id}`)).toHaveCount(0);
        await page.getByTestId(`repo-settings-submit-${repo.id}`).click();
        await expect(page.getByTestId(`repo-settings-open-${repo.id}`)).toBeVisible({
          timeout: 15_000,
        });
      } finally {
        await removeHostRepo(request, repo.id);
        await request.delete(`${API_BASE}/api/v1/repositories/${repo.id}`);
      }
    });
  });
});
