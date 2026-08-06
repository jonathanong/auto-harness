import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";

test.describe("control plane sessions", () => {
  test("sessions list page and filters", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.getByTestId("page-sessions")).toBeVisible();
    await expect(page.getByTestId("sessions-heading")).toHaveText("Sessions");
    await expect(page.getByTestId("session-filters")).toBeVisible();
    await page.getByTestId("session-filter-status").selectOption("queued");
    await expect(page).toHaveURL(/status=queued/);
  });

  test("new session form is present", async ({ page }) => {
    await page.goto("/sessions/new");
    await expect(page.getByTestId("page-session-new")).toBeVisible();
    await expect(page.getByTestId("form-create-session")).toBeVisible();
    await expect(page.getByTestId("create-session-repository-id")).toBeVisible();
    await expect(page.getByTestId("create-session-prompt")).toBeVisible();
    await expect(page.getByTestId("create-session-submit")).toBeVisible();
  });

  test("create session via API-backed form when profiles exist", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      // Host config alone populates command-profiles (no agent register — parallel-safe).
      const repoId = `pw-sess-repo-${test.info().parallelIndex}-${Date.now()}`;
      const id = `pw-sess-${test.info().parallelIndex}-${Date.now()}`;

      await putHostRepo(request, {
        id: repoId,
        path: "/tmp/pw-demo",
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", name: "wt-1", path: "/tmp/pw-demo/wt-1", labels: ["echo"] }],
      });

      try {
        await page.goto("/sessions/new");
        await expect(page.getByTestId("create-session-command-profile")).toBeEnabled({
          timeout: 15_000,
        });
        await page.getByTestId("create-session-repository-id").fill(repoId);
        await page.getByTestId("create-session-command-profile").selectOption("echo-prompt");
        await page.getByTestId("create-session-prompt").fill(`hello-${id}`);
        await page.getByTestId("create-session-timeout").fill("30");
        await page.getByTestId("create-session-submit").click();

        // Lands on the new session's own detail page, not just the list.
        await expect(page).toHaveURL(/\/sessions\/[^/?]+$/, { timeout: 15_000 });
        await expect(page.getByTestId("page-session-detail")).toBeVisible();
        await expect(page.getByTestId("session-detail-status")).toContainText("queued");

        // Queued sessions can be cancelled; cancelling unlocks resume.
        await page.getByTestId("session-cancel").click();
        await expect(page.getByTestId("session-detail-status")).toContainText("cancelled", {
          timeout: 15_000,
        });
        await expect(page.getByTestId("session-resume")).toBeVisible();
      } finally {
        await removeHostRepo(request, repoId);
      }
    });
  });

  test("unknown session id shows a not-found state", async ({ page }) => {
    await page.goto("/sessions/does-not-exist-xyz");
    await expect(page.getByTestId("page-session-detail-not-found")).toBeVisible();
  });
});
