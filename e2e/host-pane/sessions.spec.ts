import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";

const API = "http://127.0.0.1:7430";

test.describe("host pane sessions", () => {
  test("sessions page loads", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.getByTestId("page-sessions")).toBeVisible();
    await expect(page.getByTestId("sessions-heading")).toHaveText("Sessions");
    await expect(page.getByTestId("session-filters")).toBeVisible();
  });

  test("clicking a session opens its detail page", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const repoId = `pw-agent-sess-repo-${test.info().parallelIndex}-${Date.now()}`;
      const wtId = `wt-${test.info().parallelIndex}-${Date.now()}`;

      await putHostRepo(request, {
        id: repoId,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [{ id: wtId, name: wtId, path: `/tmp/${repoId}/${wtId}`, labels: ["echo"] }],
      });

      try {
        // Host config alone doesn't bring a worktree online — the scheduler only assigns to
        // online worktrees, and nothing here runs a real agent daemon. Register over REST
        // (the documented substitute for a live WebSocket connection in e2e tests).
        await request.post(`${API}/api/v1/host/messages`, {
          data: {
            type: "host:register",
            hostId: "local-1",
            worktrees: [
              {
                id: wtId,
                name: wtId,
                repositoryId: repoId,
                path: `/tmp/${repoId}/${wtId}`,
                labels: ["echo"],
              },
            ],
            commandProfiles: ["echo-prompt"],
          },
        });

        const command = await request.post(`${API}/api/v1/commands`, {
          data: {
            name: `echo-prompt-${wtId}`,
            argv: ["echo"],
            appendPrompt: true,
            providerId: null,
          },
        });
        const { id: commandId } = (await command.json()) as { id: string };

        const created = await request.post(`${API}/api/v1/sessions`, {
          data: {
            repositoryId: repoId,
            prompt: `hello-${wtId}`,
            target: { commandId },
            timeout: 30,
            requiredLabels: ["echo"],
          },
        });
        const { id } = (await created.json()) as { id: string };
        await request.post(`${API}/api/v1/scheduler/assign`);

        await page.goto("/sessions");
        await expect(page.getByTestId(`session-link-${id}`)).toBeVisible({ timeout: 15_000 });
        await page.getByTestId(`session-link-${id}`).click();

        await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
        await expect(page.getByTestId("page-session-detail")).toBeVisible();
        await expect(page.getByTestId("session-detail-id")).toHaveText(id);
        await expect(page.getByTestId("session-detail-status")).toBeVisible();
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
