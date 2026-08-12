import { test, expect, type Page } from "@playwright/test";

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
      let detailPage: Page | undefined;

      await putHostRepo(request, {
        id: repoId,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [{ id: wtId, name: wtId, path: `/tmp/${repoId}/${wtId}`, labels: ["echo"] }],
      });

      try {
        // Keep a real host socket alive so the assignment can enter running state.
        await page.goto("/sessions");
        await page.evaluate(
          ({ repositoryId, worktreeId }) =>
            new Promise<void>((resolve, reject) => {
              const socket = new WebSocket("ws://127.0.0.1:7430/ws");
              const timeout = setTimeout(() => reject(new Error("registration timed out")), 10_000);
              socket.addEventListener("message", (event) => {
                const message = JSON.parse(String(event.data)) as {
                  type?: string;
                  message?: string;
                };
                if (message.type === "host:registered") {
                  clearTimeout(timeout);
                  (globalThis as typeof globalThis & { timeoutSocket?: WebSocket }).timeoutSocket =
                    socket;
                  resolve();
                } else if (message.type === "error") {
                  clearTimeout(timeout);
                  reject(new Error(message.message));
                }
              });
              socket.addEventListener("open", () => {
                socket.send(
                  JSON.stringify({
                    type: "host:register",
                    hostId: "local-1",
                    worktrees: [
                      {
                        id: worktreeId,
                        name: worktreeId,
                        repositoryId,
                        path: `/tmp/${repositoryId}/${worktreeId}`,
                        labels: ["echo"],
                      },
                    ],
                    commandProfiles: [],
                  }),
                );
              });
            }),
          { repositoryId: repoId, worktreeId: wtId },
        );

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
            prompt: `hello-${wtId}\nhost pane second line`,
            target: { commandId },
            timeout: 30,
            requiredLabels: ["echo"],
          },
        });
        const { id } = (await created.json()) as { id: string };
        await request.post(`${API}/api/v1/scheduler/assign`);
        const assigned = await request.get(`${API}/api/v1/sessions/${id}`);
        const assignment = (await assigned.json()) as { attemptId: string; worktreeId: string };
        await page.evaluate(
          ({ sessionId, attemptId, worktreeId }) => {
            const socket = (globalThis as typeof globalThis & { timeoutSocket?: WebSocket })
              .timeoutSocket;
            if (!socket) throw new Error("host socket missing");
            socket.send(JSON.stringify({ type: "session:ack", sessionId, attemptId, worktreeId }));
          },
          { sessionId: id, attemptId: assignment.attemptId, worktreeId: assignment.worktreeId },
        );
        await expect
          .poll(async () => {
            const response = await request.get(`${API}/api/v1/sessions/${id}`);
            return ((await response.json()) as { status: string }).status;
          })
          .toBe("running");

        detailPage = await page.context().newPage();
        // Host-pane search uses the same projection, including configured route IDs.
        await detailPage.goto(`/sessions?q=${encodeURIComponent(commandId)}`);
        await expect(detailPage.getByTestId(`session-link-${id}`)).toBeVisible({ timeout: 15_000 });
        const row = detailPage.getByTestId(`session-row-${id}`);
        const createdTime = row.getByTestId(`session-created-${id}`).locator("time");
        const durationTime = row.getByTestId(`session-duration-${id}`).locator("time");
        await expect(createdTime).toHaveAttribute("title", /^\d{4}-\d\d-\d\dT.*Z$/);
        await expect(createdTime.locator(".sr-only")).toHaveText(/^Created \d{4}-/);
        await expect(durationTime.locator(".sr-only")).toHaveText("Elapsed duration:");
        const durationValue = durationTime.locator("span").last();
        await expect(durationValue).toHaveText(/^\d+s$/);
        const initialDuration = await durationValue.textContent();
        await expect.poll(() => durationValue.textContent()).not.toBe(initialDuration);
        await expect(row.getByTestId("session-prompt")).toHaveText(`hello-${wtId}`);
        await row.getByTestId("session-prompt-toggle").click();
        await expect(row.getByTestId("session-prompt")).toHaveText(
          `hello-${wtId}\nhost pane second line`,
        );
        await detailPage.getByTestId(`session-link-${id}`).click();

        await expect(detailPage).toHaveURL(new RegExp(`/sessions/${id}$`));
        await expect(detailPage.getByTestId("page-session-detail")).toBeVisible();
        await expect(detailPage.getByTestId("session-detail-id")).toHaveText(id);
        await expect(detailPage.getByTestId("session-detail-status")).toContainText("running");
        await expect(detailPage.getByTestId("session-timeout-progress")).toBeVisible();
        await expect(detailPage.getByTestId("session-timeout-remaining")).toContainText(
          "remaining",
        );

        await page.evaluate(
          ({ sessionId, attemptId, worktreeId }) => {
            const socket = (globalThis as typeof globalThis & { timeoutSocket?: WebSocket })
              .timeoutSocket;
            if (!socket) throw new Error("host socket missing");
            socket.send(
              JSON.stringify({
                type: "session:status",
                sessionId,
                attemptId,
                worktreeId,
                status: "failed",
                errorCode: "queue_expired",
              }),
            );
          },
          { sessionId: id, attemptId: assignment.attemptId, worktreeId: assignment.worktreeId },
        );
        await expect
          .poll(async () => {
            const current = await request.get(`${API}/api/v1/sessions/${id}`);
            return ((await current.json()) as { status: string }).status;
          })
          .toBe("failed");
        await detailPage.goto("/sessions");
        await expect(detailPage.getByTestId(`session-status-reason-${id}`)).toHaveText(
          "Queue expired",
        );
        await expect(detailPage.getByTestId(`session-status-${id}`)).toContainText("failed");
      } finally {
        await detailPage?.close();
        await page
          .evaluate(() => {
            (
              globalThis as typeof globalThis & { timeoutSocket?: WebSocket }
            ).timeoutSocket?.close();
          })
          .catch(() => undefined);
        await removeHostRepo(request, repoId);
      }
    });
  });

  test("unknown session id shows a not-found state", async ({ page }) => {
    await page.goto("/sessions/does-not-exist-xyz");
    await expect(page.getByTestId("page-session-detail-not-found")).toBeVisible();
  });
});
