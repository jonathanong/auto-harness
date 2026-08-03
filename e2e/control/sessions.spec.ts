import { test, expect } from "@playwright/test";

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
    // Host config alone populates command-profiles (no agent register — parallel-safe).
    // Merge into local-1's existing config instead of replacing it wholesale — other
    // specs seed worktrees on the same agent and a blind replace would clobber them.
    const id = `pw-sess-${test.info().parallelIndex}-${Date.now()}`;
    const cfgRes = await request.get(`http://127.0.0.1:7420/api/v1/agents/local-1/config`);
    const cfg = cfgRes.ok() ? await cfgRes.json() : { repositories: [], commandProfiles: {} };
    await request.put(`http://127.0.0.1:7420/api/v1/agents/local-1/config`, {
      data: {
        repositories: [
          ...(cfg.repositories ?? []).filter((r: { id: string }) => r.id !== "demo"),
          {
            id: "demo",
            path: "/tmp/pw-demo",
            defaultBranch: "main",
            worktrees: [{ id: "wt-1", path: "/tmp/pw-demo/wt-1", labels: ["echo"] }],
          },
        ],
        commandProfiles: {
          ...cfg.commandProfiles,
          "echo-prompt": { argv: ["echo"], appendPrompt: true },
        },
      },
    });

    await page.goto("/sessions/new");
    await expect(page.getByTestId("create-session-command-profile")).toBeEnabled({
      timeout: 15_000,
    });
    await page.getByTestId("create-session-repository-id").fill("demo");
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
  });

  test("unknown session id shows a not-found state", async ({ page }) => {
    await page.goto("/sessions/does-not-exist-xyz");
    await expect(page.getByTestId("page-session-detail-not-found")).toBeVisible();
  });
});
