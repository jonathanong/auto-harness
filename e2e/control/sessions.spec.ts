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
    await expect(page.getByTestId("create-session-concurrency-id")).toBeVisible();
    await expect(page.getByTestId("create-session-submit")).toBeVisible();
  });

  test("create session via API-backed form when targets exist", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      // Host config populates the repo/worktree (no agent register — parallel-safe); the
      // command itself comes from the global Command catalog, fed to the picker over
      // GET /api/v1/session-targets.
      const repoId = `pw-sess-repo-${test.info().parallelIndex}-${Date.now()}`;
      const id = `pw-sess-${test.info().parallelIndex}-${Date.now()}`;
      const commandName = `echo-prompt-${test.info().parallelIndex}-${Date.now()}`;
      const fallbackCommandName = `echo-fallback-${test.info().parallelIndex}-${Date.now()}`;
      const secondFallbackCommandName = `echo-fallback-two-${test.info().parallelIndex}-${Date.now()}`;

      await putHostRepo(request, {
        id: repoId,
        path: "/tmp/pw-demo",
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", name: "wt-1", path: "/tmp/pw-demo/wt-1", labels: ["echo"] }],
      });
      const commandResponse = await request.post("http://127.0.0.1:7430/api/v1/commands", {
        data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
      });
      const commandId = ((await commandResponse.json()) as { id: string }).id;
      const fallbackResponse = await request.post("http://127.0.0.1:7430/api/v1/commands", {
        data: { name: fallbackCommandName, argv: ["echo"], appendPrompt: true, providerId: null },
      });
      const fallbackCommandId = ((await fallbackResponse.json()) as { id: string }).id;
      const secondFallbackResponse = await request.post("http://127.0.0.1:7430/api/v1/commands", {
        data: {
          name: secondFallbackCommandName,
          argv: ["echo"],
          appendPrompt: true,
          providerId: null,
        },
      });
      const secondFallbackCommandId = ((await secondFallbackResponse.json()) as { id: string }).id;

      try {
        await page.goto("/sessions/new");
        await expect(page.getByTestId("create-session-target")).toBeEnabled({
          timeout: 15_000,
        });
        await page.getByTestId("create-session-repository-id").fill(repoId);
        await page.getByTestId("create-session-target").selectOption(`command:${commandId}`);
        await page.getByTestId("create-session-fallback-add").click();
        await page
          .getByTestId("create-session-fallback-select-0")
          .selectOption(`command:${fallbackCommandId}`);
        const firstFallbackValue = await page
          .getByTestId("create-session-fallback-select-0")
          .inputValue();
        await page.getByTestId("create-session-fallback-add").click();
        await page
          .getByTestId("create-session-fallback-select-1")
          .selectOption(`command:${secondFallbackCommandId}`);
        const secondFallbackValue = await page
          .getByTestId("create-session-fallback-select-1")
          .inputValue();
        await page.getByTestId("create-session-fallback-up-1").click();
        await page.getByTestId("create-session-fallback-down-0").click();
        await page.getByTestId("create-session-fallback-up-1").click();
        await expect(page.getByTestId("create-session-fallback-select-0")).toHaveValue(
          secondFallbackValue,
        );
        await expect(page.getByTestId("create-session-fallback-select-1")).toHaveValue(
          firstFallbackValue,
        );
        await page.getByTestId("create-session-fallback-remove-1").click();
        await expect(page.getByTestId("create-session-fallback-select-1")).toHaveCount(0);
        await page.getByTestId("create-session-prompt").fill(`hello-${id}`);
        await page.getByTestId("create-session-timeout").fill("30");
        const createRequest = page.waitForRequest(
          (req) => req.url().endsWith("/api/v1/sessions") && req.method() === "POST",
        );
        await page.getByTestId("create-session-concurrency-id").fill(`pw-concurrency-${id}`);
        await page.getByTestId("create-session-submit").click();
        expect((await createRequest).postDataJSON()).toMatchObject({
          target: expect.objectContaining({ commandId: expect.any(String) }),
          fallbacks: [expect.objectContaining({ commandId: expect.any(String) })],
        });

        // Lands on the new session's own detail page, not just the list.
        await expect(page).toHaveURL(/\/sessions\/[^/?]+$/, { timeout: 15_000 });
        await expect(page.getByTestId("page-session-detail")).toBeVisible();
        await expect(page.getByTestId("session-detail-status")).toContainText("queued");
        await expect(page.getByTestId("session-detail-concurrency-id")).toContainText(
          `pw-concurrency-${id}`,
        );

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

  test("filters sessions by exact concurrency ID", async ({ page }) => {
    await page.goto("/sessions");
    await page.getByTestId("session-filter-concurrency-id").fill("pw-concurrency-example");
    await page.getByTestId("session-filter-concurrency-id").press("Enter");
    await expect(page).toHaveURL(/concurrencyId=pw-concurrency-example/);
  });

  test("unknown session id shows a not-found state", async ({ page }) => {
    await page.goto("/sessions/does-not-exist-xyz");
    await expect(page.getByTestId("page-session-detail-not-found")).toBeVisible();
  });
});
