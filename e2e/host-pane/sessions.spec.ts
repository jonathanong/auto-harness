/* eslint-disable max-lines -- the end-to-end host registration and lifecycle flow stays together. */
import { test, expect, type Page } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";
import { API_BASE, WS_BASE } from "../harness-endpoints.ts";

const API = API_BASE;

test.describe("host pane sessions", () => {
  test("sessions page loads", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.getByTestId("page-sessions")).toBeVisible();
    await expect(page.getByTestId("sessions-heading")).toHaveText("Sessions");
    await expect(page.getByTestId("session-filters")).toBeVisible();
    const createdSort = page.getByTestId("session-sort-created");
    await expect(createdSort).toHaveAccessibleName("Sort by creation time, oldest first");
    await createdSort.click();
    await expect(page).toHaveURL(/sort=oldest/);
    await expect(createdSort.locator("..")).toHaveAttribute("aria-sort", "ascending");
    await expect(createdSort).toHaveAccessibleName("Sort by creation time, newest first");
    const prioritySort = page.getByTestId("session-sort-priority");
    await expect(prioritySort).toHaveAccessibleName("Sort by priority, high to low");
    await prioritySort.click();
    await expect(page).toHaveURL(/sort=priority_desc/);
    await expect(prioritySort.locator("..")).toHaveAttribute("aria-sort", "descending");
  });

  test("clicking a session opens its detail page", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const suffix = `${test.info().parallelIndex}-${Date.now()}`;
      const repositoryName = `pw-host-session-repository-${suffix}`;
      const repository = await request.post(`${API}/api/v1/repositories`, {
        data: {
          name: repositoryName,
          url: `https://git.example.test/pw-agent-sess-repo-${suffix}.git`,
          defaultBranch: "main",
        },
      });
      expect(repository.status()).toBe(201);
      const repoId = ((await repository.json()) as { id: string }).id;
      const wtId = `wt-${test.info().parallelIndex}-${Date.now()}`;
      let detailPage: Page | undefined;

      await putHostRepo(request, {
        id: repoId,
        path: `/tmp/${repoId}`,
        defaultBranch: "main",
        worktrees: [{ id: wtId, name: wtId, path: `/tmp/${repoId}/${wtId}`, labels: ["echo"] }],
      });

      try {
        await page.goto("/sessions");
        await page.evaluate(
          ({ repositoryId, worktreeId }) =>
            new Promise<void>((resolve, reject) => {
              const socket = new WebSocket(WS_BASE);
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

        const prompt = `hello-${wtId}\nhost pane second line`;
        const created = await request.post(`${API}/api/v1/sessions`, {
          data: {
            repositoryId: repoId,
            prompt,
            target: { commandId },
            timeout: 30,
            requiredLabels: ["echo"],
          },
        });
        const { id } = (await created.json()) as { id: string };
        detailPage = await page.context().newPage();
        await detailPage.goto(`/sessions/${encodeURIComponent(id)}`);
        await expect(detailPage.getByTestId("session-detail-queue-deadline")).toBeVisible();
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

        await expect(detailPage.getByTestId("session-detail-status")).toContainText("running", {
          timeout: 15_000,
        });
        await expect(detailPage.getByTestId("session-detail-queue-deadline")).toHaveCount(0);

        // Host-pane search uses the same projection, including configured route IDs.
        await detailPage.goto(`/sessions?q=${encodeURIComponent(commandId)}`);
        await expect(detailPage.getByTestId(`session-link-${id}`)).toBeVisible({ timeout: 15_000 });
        const row = detailPage.getByTestId(`session-row-${id}`);
        const repositoryCell = row.getByTestId(`session-repository-${id}`);
        await expect(repositoryCell).toHaveText(repositoryName);
        await expect(repositoryCell.locator("a")).toHaveAttribute(
          "href",
          `/repositories/${repoId}`,
        );
        await expect(row.getByTestId("session-source-api")).toHaveText("api");
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
        await expect(
          detailPage.getByTestId("session-detail-created").locator("time"),
        ).toHaveAttribute("datetime");
        await expect(
          detailPage.getByTestId("session-detail-started").locator("time"),
        ).toHaveAttribute("datetime");
        await expect(detailPage.getByTestId("session-detail-duration")).toContainText(/\d+s/);
        await expect(detailPage.getByTestId("session-detail-source")).toContainText("api");
        await expect(detailPage.getByTestId("session-source-api")).toBeVisible();
        await expect(detailPage.getByTestId("session-detail-worktree")).toHaveText(wtId);
        await expect(detailPage.getByTestId("session-detail-priority")).toHaveText("0");
        const promptContent = detailPage.getByTestId("session-detail-prompt-content");
        await expect(promptContent).toBeVisible();
        expect(await promptContent.textContent()).toBe(prompt);
        await promptContent.focus();
        await expect(promptContent).toBeFocused();
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
        await expect(detailPage.getByTestId("session-detail-status-reason")).toHaveText(
          "Queue expired",
        );

        const secondCreated = await request.post(`${API}/api/v1/sessions`, {
          data: {
            repositoryId: repoId,
            prompt: `second-${wtId}`,
            target: { commandId },
            timeout: 30,
            requiredLabels: ["echo"],
          },
        });
        expect(secondCreated.status()).toBe(201);
        const secondId = ((await secondCreated.json()) as { id: string }).id;
        await request.post(`${API}/api/v1/scheduler/assign`);
        const secondAssigned = await request.get(`${API}/api/v1/sessions/${secondId}`);
        const secondAssignment = (await secondAssigned.json()) as {
          attemptId: string;
          worktreeId: string;
        };
        await page.evaluate(
          ({ sessionId, attemptId, worktreeId }) => {
            const socket = (globalThis as typeof globalThis & { timeoutSocket?: WebSocket })
              .timeoutSocket;
            if (!socket) throw new Error("host socket missing");
            socket.send(JSON.stringify({ type: "session:ack", sessionId, attemptId, worktreeId }));
            socket.send(
              JSON.stringify({
                type: "session:status",
                sessionId,
                attemptId,
                worktreeId,
                status: "failed",
              }),
            );
          },
          {
            sessionId: secondId,
            attemptId: secondAssignment.attemptId,
            worktreeId: secondAssignment.worktreeId,
          },
        );
        await expect
          .poll(async () => {
            const current = await request.get(`${API}/api/v1/sessions/${secondId}`);
            return ((await current.json()) as { status: string }).status;
          })
          .toBe("failed");

        await page.goto(`/sessions?limit=1&repositoryId=${repoId}`);
        await expect(page.locator("[data-session-row-id]")).toHaveCount(1);
        const boundedUrl = page.url();
        await page.getByTestId("sessions-load-more").click();
        await expect(page.getByTestId(`session-row-${id}`)).toBeVisible();
        await expect(page.getByTestId(`session-row-${secondId}`)).toBeVisible();
        await expect(page.locator("[data-session-row-id]")).toHaveCount(2);
        expect(page.url()).toBe(boundedUrl);
        await page.locator("body").press("j");
        await page.locator("body").press("j");
        await expect(page.locator('[data-session-row-id][aria-selected="true"]')).toHaveCount(1);
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
});
