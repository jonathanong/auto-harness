/* eslint-disable max-lines, no-shadow -- the end-to-end WebSocket reporting flow stays in one auditable scenario. */
import { test, expect } from "@playwright/test";

import { putHostRepo, removeHostRepo, withLocalHostLock } from "../local-1-host.ts";
import { API_BASE, WS_BASE } from "../harness-endpoints.ts";

test.describe("control plane sessions", () => {
  test("sessions list page and filters", async ({ page, request }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const repositoryName = `pw-session-repository-${suffix}`;
    const hostId = `pw-session-filter-host-${suffix}`;
    const repository = await request.post(`${API_BASE}/api/v1/repositories`, {
      data: {
        name: repositoryName,
        url: `https://git.example.test/pw-session-list-${suffix}.git`,
        defaultBranch: "main",
      },
    });
    expect(repository.status()).toBe(201);
    const repositoryId = ((await repository.json()) as { id: string }).id;
    const command = await request.post(`${API_BASE}/api/v1/commands`, {
      data: {
        name: `pw-session-list-${Date.now()}`,
        argv: ["echo"],
        appendPrompt: true,
        providerId: null,
      },
    });
    expect(command.status()).toBe(201);
    const commandId = ((await command.json()) as { id: string }).id;
    const created = await request.post(`${API_BASE}/api/v1/sessions`, {
      data: {
        repositoryId,
        prompt: "exercise session list controls",
        target: { commandId },
        timeout: 30,
      },
    });
    expect(created.status()).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    const secondCreated = await request.post(`${API_BASE}/api/v1/sessions`, {
      data: {
        repositoryId,
        prompt: "exercise appended session page",
        target: { commandId },
        timeout: 30,
      },
    });
    expect(secondCreated.status()).toBe(201);
    const secondSessionId = ((await secondCreated.json()) as { id: string }).id;
    expect(
      (
        await request.put(`${API_BASE}/api/v1/hosts/${hostId}/inventory`, {
          data: { repositories: [], commandProfiles: {} },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/sessions?limit=1&repositoryId=${repositoryId}`);
    await expect(
      page.getByTestId("page-sessions").or(page.getByTestId("sessions-loading")).first(),
    ).toBeVisible();
    await expect(page.getByTestId("page-sessions")).toBeVisible();
    await expect(page.getByTestId("sessions-heading")).toHaveText("Sessions");
    await expect(page.locator("[data-session-row-id]")).toHaveCount(1);
    const boundedUrl = page.url();
    await page.getByTestId("sessions-load-more").click();
    await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible();
    await expect(page.getByTestId(`session-row-${secondSessionId}`)).toBeVisible();
    await expect(page.locator("[data-session-row-id]")).toHaveCount(2);
    expect(page.url()).toBe(boundedUrl);
    await page.locator("body").press("j");
    await page.locator("body").press("j");
    await expect(page.locator('[data-session-row-id][aria-selected="true"]')).toHaveCount(1);
    await page.goto("/sessions");
    await expect(page.getByTestId("session-source-api").first()).toHaveText("api");
    const repositoryCell = page.getByTestId(`session-repository-${sessionId}`);
    await expect(repositoryCell).toHaveText(repositoryName);
    await expect(repositoryCell.locator("a")).toHaveAttribute(
      "href",
      `/repositories/${repositoryId}`,
    );
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
    await expect(prioritySort).toHaveAccessibleName("Sort by priority, low to high");
    await prioritySort.click();
    await expect(page).toHaveURL(/sort=priority_asc/);
    await expect(prioritySort.locator("..")).toHaveAttribute("aria-sort", "ascending");
    await page.getByTestId("session-filter-status").selectOption("queued");
    await expect(page).toHaveURL(/status=queued/);
    await expect(page).toHaveURL(/sort=priority_asc/);
    await page.getByTestId("session-filter-q").fill("debounced prompt");
    await expect(page).toHaveURL(/q=debounced\+prompt/);
    await page.getByTestId("session-filter-repository").selectOption(repositoryId);
    await expect(page).toHaveURL(new RegExp(`repositoryId=${repositoryId}`));
    await page.getByTestId("session-filter-agent").selectOption(hostId);
    await expect(page).toHaveURL(new RegExp(`hostId=${hostId}`));
    await page.getByTestId("session-filter-source").selectOption("api");
    await expect(page).toHaveURL(/source=api/);
    await expect(page).toHaveURL(/sort=priority_asc/);
    await expect(page).toHaveURL(/q=debounced\+prompt/);
  });

  test("sessions list exposes a retryable API error without an empty table", async ({ page }) => {
    await page.goto("/sessions?cursor=not-a-valid-cursor");
    const error = page.getByTestId("sessions-api-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Could not load sessions.");
    await expect(page.getByTestId("sessions-table")).toHaveCount(0);

    const refresh = page.waitForResponse(
      (response) =>
        response.request().resourceType() === "fetch" &&
        response.url().includes("/sessions?cursor=not-a-valid-cursor"),
    );
    await page.getByTestId("sessions-api-retry").click();
    await refresh;
    await expect(error).toBeVisible();
  });

  test("new session form is present", async ({ page }) => {
    await page.goto("/sessions/new");
    await expect(page.getByTestId("page-session-new")).toBeVisible();
    await expect(page.getByTestId("session-new-heading")).toHaveText("New session");
    await expect(page.getByTestId("form-create-session")).toBeVisible();
    await expect(page.getByTestId("create-session-repository-id")).toBeVisible();
    await expect(page.getByTestId("create-session-prompt")).toBeVisible();
    await page.getByTestId("create-session-prompt").fill("# Review **carefully**");
    await page.getByTestId("create-session-prompt-preview-toggle").click();
    await expect(page.getByTestId("create-session-prompt-preview")).toHaveText("Review carefully");
    await page.getByTestId("create-session-prompt-write").click();
    await expect(page.getByTestId("create-session-prompt")).toBeVisible();
    await expect(page.getByTestId("create-session-timeout-control")).toBeVisible();
    await expect(page.getByTestId("create-session-timeout")).toBeVisible();
    await expect(page.getByTestId("create-session-timeout")).toHaveValue("custom");
    await expect(page.getByTestId("create-session-timeout-custom")).toHaveValue("600");
    await expect(page.getByTestId("create-session-ref")).toBeVisible();
    await expect(page.getByTestId("create-session-scheduling-fields")).toBeVisible();
    await expect(page.getByTestId("create-session-priority")).toHaveValue("0");
    await expect(page.getByTestId("create-session-priority-value")).toHaveText("0 (low)");
    await expect(page.getByTestId("create-session-labels")).toBeVisible();
    await expect(page.getByTestId("create-session-queue-ttl")).toBeVisible();
    await expect(page.getByTestId("create-session-routing")).toBeVisible();
    await expect(page.getByTestId("create-session-concurrency-id")).toBeVisible();
    await expect(page.getByTestId("create-session-error")).toBeHidden();
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

      const repositoryResponse = await request.post(`${API_BASE}/api/v1/repositories`, {
        data: { name: repoId, url: `/tmp/${repoId}`, defaultBranch: "main" },
      });
      expect(repositoryResponse.ok()).toBe(true);
      const repositoryId = ((await repositoryResponse.json()) as { id: string }).id;
      await putHostRepo(request, {
        id: repositoryId,
        path: "/tmp/pw-demo",
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", name: "wt-1", path: "/tmp/pw-demo/wt-1", labels: ["echo"] }],
      });
      const commandResponse = await request.post(`${API_BASE}/api/v1/commands`, {
        data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
      });
      const commandId = ((await commandResponse.json()) as { id: string }).id;
      const fallbackResponse = await request.post(`${API_BASE}/api/v1/commands`, {
        data: { name: fallbackCommandName, argv: ["echo"], appendPrompt: true, providerId: null },
      });
      const fallbackCommandId = ((await fallbackResponse.json()) as { id: string }).id;
      const secondFallbackResponse = await request.post(`${API_BASE}/api/v1/commands`, {
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
        await page.getByTestId("create-session-repository-id").selectOption(repositoryId);
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
        const prompt = `hello-${id}\nSecond line <strong>stays text</strong>`;
        await page.getByTestId("create-session-prompt").fill(prompt);
        await page.getByTestId("create-session-timeout").selectOption("1800");
        await expect(page.getByTestId("create-session-timeout-custom")).toHaveCount(0);
        const createRequest = page.waitForRequest(
          (req) => req.url().endsWith("/api/v1/sessions") && req.method() === "POST",
        );
        await page.getByTestId("create-session-concurrency-id").fill(`pw-concurrency-${id}`);
        await page.getByTestId("create-session-submit").click();
        expect((await createRequest).postDataJSON()).toMatchObject({
          target: expect.objectContaining({ commandId: expect.any(String) }),
          fallbacks: [expect.objectContaining({ commandId: expect.any(String) })],
          timeout: 1800,
          prompt,
        });

        // Lands on the new session's own detail page, not just the list.
        await expect(page).toHaveURL(/\/sessions\/[^/?]+$/, { timeout: 15_000 });
        await expect(page.getByTestId("page-session-detail")).toBeVisible();
        await expect(page.getByTestId("session-detail-status")).toContainText("queued");
        await expect(page.getByTestId("session-detail-source")).toContainText("ui");
        await expect(page.getByTestId("session-source-ui")).toBeVisible();
        const queueDeadline = page.getByTestId("session-detail-queue-deadline");
        await expect(queueDeadline.locator("time")).toHaveAttribute("datetime");
        await expect(queueDeadline).toContainText("remaining");
        await expect(page.getByTestId("session-detail-priority")).toHaveText("0");
        await expect(page.getByTestId("session-detail-concurrency-id")).toContainText(
          `pw-concurrency-${id}`,
        );
        const promptContent = page.getByTestId("session-detail-prompt-content");
        await expect(promptContent).toBeVisible();
        expect(await promptContent.textContent()).toBe(prompt);
        await expect(promptContent).toHaveAttribute("tabindex", "0");
        await expect(page.getByTestId("create-session-error")).toHaveCount(0);

        // Client search includes configured fallback route fields that are not in the prompt.
        const createdSessionId = decodeURIComponent(
          new URL(page.url()).pathname.split("/").at(-1)!,
        );
        await page.goto(`/sessions?q=${encodeURIComponent(secondFallbackCommandId)}`);
        await expect(page.getByTestId(`session-row-${createdSessionId}`)).toBeVisible();
        await page.goto(`/sessions/${encodeURIComponent(createdSessionId)}`);

        // Queued sessions can be cancelled; cancelling unlocks resume.
        await expect(page.getByTestId("session-cancel")).toHaveText("Cancel session");
        await expect(page.getByTestId("session-cancel")).toHaveAttribute("aria-busy", "false");
        await page.getByTestId("session-cancel").click();
        await expect(page.getByTestId("session-detail-status")).toContainText("cancelled", {
          timeout: 15_000,
        });
        await expect(page.getByTestId("session-resume")).toHaveText("Resume");
        const sessionId = createdSessionId;

        // Lists show one safe-text line by default and disclose the full prompt on demand.
        await page.goto(`/sessions?q=${encodeURIComponent(sessionId)}`);
        const row = page.getByTestId(`session-row-${sessionId}`);
        const created = row.getByTestId(`session-created-${sessionId}`).locator("time");
        await expect(created).toBeVisible();
        await expect(created).toHaveAttribute("title", /^\d{4}-\d\d-\d\dT.*Z$/);
        await expect(created.locator(".sr-only")).toHaveText(/^Created \d{4}-/);
        await expect(row.getByTestId(`session-duration-${sessionId}`)).toHaveText("—");
        const promptText = row.getByTestId("session-prompt");
        const promptToggle = row.getByTestId("session-prompt-toggle");
        await expect(promptText).toHaveText(`hello-${id}`);
        await expect(promptToggle).toHaveText("Show full prompt");
        await expect(promptToggle).toHaveAttribute("aria-expanded", "false");
        await expect(row.locator("strong")).toHaveCount(0);
        const controlledId = await promptToggle.getAttribute("aria-controls");
        expect(controlledId).toBeTruthy();
        await expect(promptText).toHaveAttribute("id", controlledId!);
        await promptToggle.click();
        await expect(promptText).toHaveText(prompt);
        await expect(promptToggle).toHaveAttribute("aria-expanded", "true");
        await expect(row.locator("strong")).toHaveCount(0);
        await promptToggle.click();
        await expect(promptText).toHaveText(`hello-${id}`);

        const expiring = await request.post(`${API_BASE}/api/v1/sessions`, {
          data: {
            repositoryId: repoId,
            prompt: `expire-${id}`,
            target: { commandId },
            timeout: 30,
            queueTtlSeconds: 1,
            requiredLabels: ["no-matching-worktree"],
          },
        });
        expect(expiring.ok()).toBe(true);
        const { id: expiringId } = (await expiring.json()) as { id: string };
        await page.waitForTimeout(1_100);
        await request.post(`${API_BASE}/api/v1/scheduler/assign`);
        await page.goto(`/sessions?q=${encodeURIComponent(expiringId)}`);
        const expiredReason = page.getByTestId(`session-status-reason-${expiringId}`);
        await expect(expiredReason).toHaveText("Queue expired");
        await expect(page.getByTestId(`session-status-${expiringId}`)).toContainText("failed");
        await page.getByTestId(`session-link-${expiringId}`).click();
        await expect(page.getByTestId("session-detail-status-reason")).toHaveText("Queue expired");
      } finally {
        await removeHostRepo(request, repoId);
      }
    });
  });

  test("warns and confirms force-cancel when an assigned agent disconnects", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const hostId = `pw-offline-host-${suffix}`;
    const repoId = `pw-offline-repo-${suffix}`;
    const worktreeId = `pw-offline-worktree-${suffix}`;
    const inventory = await request.put(`${API_BASE}/api/v1/hosts/${hostId}/inventory`, {
      data: {
        repositories: [
          {
            id: repoId,
            path: `/tmp/${repoId}`,
            defaultBranch: "main",
            worktrees: [
              {
                id: worktreeId,
                name: worktreeId,
                path: `/tmp/${repoId}/${worktreeId}`,
                labels: [],
              },
            ],
          },
        ],
        providerAccounts: [],
        commandProfiles: {},
      },
    });
    expect(inventory.ok()).toBe(true);
    const command = await request.post(`${API_BASE}/api/v1/commands`, {
      data: { name: `pw-offline-command-${suffix}`, argv: ["echo"], providerId: null },
    });
    expect(command.ok()).toBe(true);
    const commandId = ((await command.json()) as { id: string }).id;

    await page.goto("/sessions");
    await page.evaluate(
      ({ hostId, repoId, worktreeId, wsBase }) =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(wsBase);
          const timeout = setTimeout(
            () => reject(new Error("host registration timed out")),
            10_000,
          );
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
            if (message.type === "host:registered") {
              clearTimeout(timeout);
              (globalThis as typeof globalThis & { offlineSocket?: WebSocket }).offlineSocket =
                socket;
              resolve();
            }
            if (message.type === "error") {
              clearTimeout(timeout);
              reject(new Error(message.message));
            }
          });
          socket.addEventListener("error", () => reject(new Error("host WebSocket failed")));
          socket.addEventListener("open", () => {
            socket.send(
              JSON.stringify({
                type: "host:register",
                hostId,
                worktrees: [
                  {
                    id: worktreeId,
                    name: worktreeId,
                    repositoryId: repoId,
                    path: `/tmp/${repoId}/${worktreeId}`,
                    labels: [],
                  },
                ],
                commandProfiles: [],
              }),
            );
          });
        }),
      { hostId, repoId, worktreeId, wsBase: WS_BASE },
    );

    const created = await request.post(`${API_BASE}/api/v1/sessions`, {
      data: { repositoryId: repoId, prompt: "stay running", target: { commandId }, timeout: 300 },
    });
    expect(created.status()).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    expect((await request.post(`${API_BASE}/api/v1/scheduler/assign`)).ok()).toBe(true);
    const assigned = (await (
      await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`)
    ).json()) as { attemptId: string; worktreeId: string };
    await page.evaluate(
      ({ sessionId, attemptId, worktreeId }) => {
        const socket = (globalThis as typeof globalThis & { offlineSocket?: WebSocket })
          .offlineSocket;
        if (!socket) throw new Error("host socket missing");
        socket.send(JSON.stringify({ type: "session:ack", sessionId, attemptId, worktreeId }));
      },
      { sessionId, attemptId: assigned.attemptId, worktreeId: assigned.worktreeId },
    );
    await expect
      .poll(async () => {
        const response = await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`);
        return ((await response.json()) as { ackReceivedAt?: string }).ackReceivedAt;
      })
      .toBeTruthy();
    await page.evaluate(() => {
      (globalThis as typeof globalThis & { offlineSocket?: WebSocket }).offlineSocket?.close();
    });
    await expect
      .poll(async () => {
        const response = await request.get(`${API_BASE}/api/v1/hosts`);
        const hosts = (await response.json()) as {
          items: Array<{ hostId: string; online: boolean }>;
        };
        return hosts.items.find((host) => host.hostId === hostId)?.online;
      })
      .toBe(false);

    await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId("session-live-state-error")).toHaveCount(0);
    await expect(page.getByTestId("session-agent-offline")).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("session-agent-offline")).toContainText(
      "Agent disconnected — session may be stale",
    );
    await expect(page.getByTestId("session-cancel")).toHaveCount(0);
    await page.getByTestId("session-force-cancel").click();
    await expect(page.getByTestId("session-force-cancel-confirm")).toContainText(
      "cannot confirm that its remote process stopped",
    );
    await page.getByTestId("session-force-cancel-confirm-submit").click();
    await expect(page.getByTestId("session-detail-status")).toContainText("cancelled", {
      timeout: 15_000,
    });
    await page.getByTestId("session-resume").click();
    await expect(page.getByTestId("session-resume-dialog")).toBeVisible();
    await page.getByTestId("session-resume-prompt").fill("continue from review");
    await page.getByTestId("session-resume-timeout").fill("45");
    await page.getByTestId("session-resume-priority").fill("60");
    const resumeRequest = page.waitForRequest(
      (request) => request.url().endsWith("/resume") && request.method() === "POST",
    );
    await page.getByTestId("session-resume-submit").click();
    expect((await resumeRequest).postDataJSON()).toEqual({
      prompt: "continue from review",
      timeout: 45,
      priority: 60,
    });
    await expect(page).not.toHaveURL(`/sessions/${encodeURIComponent(sessionId)}`, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("session-detail-status")).toContainText("queued");
  });

  test("session detail reports CLI usage and configured cost", async ({ page, request }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const hostId = `pw-usage-host-${suffix}`;
    const repoId = `pw-usage-repo-${suffix}`;
    const worktreeId = `pw-usage-worktree-${suffix}`;
    const providerName = `pw-usage-provider-${suffix}`;
    let providerId: string | undefined;
    let accountId: string | undefined;
    let commandId: string | undefined;

    try {
      const provider = await request.post(`${API_BASE}/api/v1/providers`, {
        data: {
          name: providerName,
          usageRates: { currency: "USD", inputTokenMicros: "2" },
        },
      });
      expect(provider.ok()).toBe(true);
      providerId = ((await provider.json()) as { id: string }).id;

      const account = await request.post(`${API_BASE}/api/v1/provider-accounts`, {
        data: { providerId, label: `${providerName}@example.com` },
      });
      expect(account.ok()).toBe(true);
      accountId = ((await account.json()) as { id: string }).id;

      const command = await request.post(`${API_BASE}/api/v1/commands`, {
        data: { name: `${providerName}-command`, argv: ["echo"], providerId },
      });
      expect(command.ok()).toBe(true);
      commandId = ((await command.json()) as { id: string }).id;

      const inventory = await request.put(`${API_BASE}/api/v1/hosts/${hostId}/inventory`, {
        data: {
          repositories: [
            {
              id: repoId,
              path: "/tmp/pw-usage",
              defaultBranch: "main",
              worktrees: [
                {
                  id: worktreeId,
                  name: worktreeId,
                  path: "/tmp/pw-usage/worktree",
                  labels: [],
                },
              ],
            },
          ],
          providerAccounts: [{ providerAccountId: accountId }],
          commandProfiles: {},
        },
      });
      expect(inventory.ok()).toBe(true);

      // Connect from the control-plane origin (rather than an opaque blank-page
      // origin) to exercise the same browser WebSocket policy as the real UI.
      await page.goto("/sessions");
      await page.evaluate(
        ({ hostId, repoId, worktreeId, wsBase }) =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(wsBase);
            const timeout = setTimeout(
              () => reject(new Error("host registration timed out")),
              10_000,
            );
            socket.addEventListener("message", (event) => {
              const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
              if (message.type === "host:registered") {
                clearTimeout(timeout);
                (globalThis as typeof globalThis & { usageSocket?: WebSocket }).usageSocket =
                  socket;
                resolve();
              }
              if (message.type === "error") {
                clearTimeout(timeout);
                reject(new Error(message.message));
              }
            });
            socket.addEventListener("error", () => {
              clearTimeout(timeout);
              reject(new Error("host WebSocket failed"));
            });
            socket.addEventListener("open", () => {
              socket.send(
                JSON.stringify({
                  type: "host:register",
                  hostId,
                  worktrees: [
                    {
                      id: worktreeId,
                      name: worktreeId,
                      repositoryId: repoId,
                      path: "/tmp/pw-usage/worktree",
                      labels: [],
                    },
                  ],
                  commandProfiles: [],
                }),
              );
            });
          }),
        { hostId, repoId, worktreeId, wsBase: WS_BASE },
      );

      const created = await request.post(`${API_BASE}/api/v1/sessions`, {
        data: { repositoryId: repoId, prompt: "report usage", target: { commandId }, timeout: 30 },
      });
      expect(created.status()).toBe(201);
      const sessionId = ((await created.json()) as { id: string }).id;
      expect((await request.post(`${API_BASE}/api/v1/scheduler/assign`)).ok()).toBe(true);

      const assigned = await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`);
      expect(assigned.ok()).toBe(true);
      const session = (await assigned.json()) as { attemptId: string; worktreeId: string };
      await page.evaluate(
        ({ sessionId, attemptId, worktreeId }) => {
          const socket = (globalThis as typeof globalThis & { usageSocket?: WebSocket })
            .usageSocket;
          if (!socket) throw new Error("host socket missing");
          socket.send(JSON.stringify({ type: "session:ack", sessionId, attemptId, worktreeId }));
        },
        { sessionId, attemptId: session.attemptId, worktreeId: session.worktreeId },
      );
      await expect
        .poll(async () => {
          const response = await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`);
          return ((await response.json()) as { status: string }).status;
        })
        .toBe("running");

      // Keep the host socket alive in this page while a second production page verifies the timer.
      const detailPage = await page.context().newPage();
      await detailPage.goto(`/sessions/${sessionId}`);
      const timeoutProgress = detailPage.getByTestId("session-timeout-progress");
      await expect(timeoutProgress).toBeVisible();
      await expect(timeoutProgress.getByRole("progressbar")).toHaveAttribute(
        "aria-valuetext",
        / remaining$/,
      );
      await expect(detailPage.getByTestId("session-timeout-remaining")).toContainText("remaining");
      await detailPage.close();

      await page.evaluate(
        ({ sessionId, attemptId, worktreeId }) => {
          const socket = (globalThis as typeof globalThis & { usageSocket?: WebSocket })
            .usageSocket;
          if (!socket) throw new Error("host socket missing");
          socket.send(
            JSON.stringify({
              type: "session:usage",
              sessionId,
              attemptId,
              worktreeId,
              usage: {
                kind: "delta",
                sequence: 1,
                inputTokens: "12",
                source: "cli",
                observedAt: "2026-01-01T00:00:00.000Z",
              },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "session:status",
              sessionId,
              attemptId,
              worktreeId,
              status: "completed",
            }),
          );
        },
        { sessionId, attemptId: session.attemptId, worktreeId: session.worktreeId },
      );

      await expect
        .poll(async () => {
          const usage = await request.get(`${API_BASE}/api/v1/sessions/${sessionId}/usage`);
          return ((await usage.json()) as { aggregate: { inputTokens: string } }).aggregate
            .inputTokens;
        })
        .toBe("12");

      await page.goto(`/sessions/${sessionId}`);
      await expect(page.getByTestId("session-usage-summary")).toBeVisible();
      await expect(page.getByTestId("session-usage-input")).toHaveText("12");
      await expect(page.getByTestId("session-usage-output")).toHaveText("0");
      await expect(page.getByTestId("session-usage-total")).toHaveText("0");
      await expect(page.getByTestId("session-usage-cost")).toHaveText("24 USD micros");
    } finally {
      await page
        .evaluate(() => {
          (globalThis as typeof globalThis & { usageSocket?: WebSocket }).usageSocket?.close();
        })
        .catch(() => undefined);
      await request.delete(`${API_BASE}/api/v1/hosts/${hostId}/inventory`).catch(() => undefined);
      if (commandId)
        await request.delete(`${API_BASE}/api/v1/commands/${commandId}`).catch(() => undefined);
      if (accountId)
        await request
          .delete(`${API_BASE}/api/v1/provider-accounts/${accountId}`)
          .catch(() => undefined);
      if (providerId)
        await request.delete(`${API_BASE}/api/v1/providers/${providerId}`).catch(() => undefined);
    }
  });

  test("filters sessions by exact concurrency ID", async ({ page }) => {
    await page.goto("/sessions");
    await page.getByTestId("session-filter-concurrency-id").fill("pw-concurrency-example");
    await page.getByTestId("session-filter-concurrency-id").press("Enter");
    await expect(page).toHaveURL(/concurrencyId=pw-concurrency-example/);
  });

  test("shows a terminal error code without requiring an error message", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const hostId = `pw-error-code-host-${suffix}`;
    const repositoryName = `pw-error-code-repo-${suffix}`;
    const worktreeId = `pw-error-code-worktree-${suffix}`;
    let commandId: string | undefined;

    try {
      const repository = await request.post(`${API_BASE}/api/v1/repositories`, {
        data: { name: repositoryName, url: `/tmp/${repositoryName}`, defaultBranch: "main" },
      });
      const repositoryId = ((await repository.json()) as { id: string }).id;
      const command = await request.post(`${API_BASE}/api/v1/commands`, {
        data: { name: `pw-error-code-${suffix}`, argv: ["echo"], appendPrompt: true },
      });
      commandId = ((await command.json()) as { id: string }).id;
      expect(
        (
          await request.put(`${API_BASE}/api/v1/hosts/${hostId}/inventory`, {
            data: {
              repositories: [
                {
                  id: repositoryId,
                  path: `/tmp/${repositoryName}`,
                  defaultBranch: "main",
                  worktrees: [
                    {
                      id: worktreeId,
                      name: worktreeId,
                      path: `/tmp/${repositoryName}/worktree`,
                      labels: [],
                    },
                  ],
                },
              ],
              commandProfiles: {},
            },
          })
        ).ok(),
      ).toBe(true);

      await page.goto("/sessions");
      await page.evaluate(
        ({ hostId, repositoryId, worktreeId, wsBase }) =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(wsBase);
            const timeout = setTimeout(
              () => reject(new Error("host registration timed out")),
              10_000,
            );
            socket.addEventListener("message", (event) => {
              const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
              if (message.type === "host:registered") {
                clearTimeout(timeout);
                (
                  globalThis as typeof globalThis & { errorCodeSocket?: WebSocket }
                ).errorCodeSocket = socket;
                resolve();
              }
              if (message.type === "error") {
                clearTimeout(timeout);
                reject(new Error(message.message));
              }
            });
            socket.addEventListener("error", () => {
              clearTimeout(timeout);
              reject(new Error("host WebSocket failed"));
            });
            socket.addEventListener("open", () => {
              socket.send(
                JSON.stringify({
                  type: "host:register",
                  hostId,
                  worktrees: [
                    {
                      id: worktreeId,
                      name: worktreeId,
                      repositoryId,
                      path: `/tmp/${repositoryId}/worktree`,
                      labels: [],
                    },
                  ],
                  commandProfiles: [],
                }),
              );
            });
          }),
        { hostId, repositoryId, worktreeId, wsBase: WS_BASE },
      );

      const created = await request.post(`${API_BASE}/api/v1/sessions`, {
        data: {
          repositoryId,
          prompt: "report a message-free terminal failure",
          target: { commandId },
          timeout: 30,
        },
      });
      const sessionId = ((await created.json()) as { id: string }).id;
      expect((await request.post(`${API_BASE}/api/v1/scheduler/assign`)).ok()).toBe(true);
      const assigned = (await (
        await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`)
      ).json()) as { attemptId: string; worktreeId: string };
      await page.evaluate(
        ({ sessionId, attemptId, worktreeId }) => {
          const socket = (globalThis as typeof globalThis & { errorCodeSocket?: WebSocket })
            .errorCodeSocket;
          if (!socket) throw new Error("host socket missing");
          socket.send(JSON.stringify({ type: "session:ack", sessionId, attemptId, worktreeId }));
        },
        { sessionId, attemptId: assigned.attemptId, worktreeId: assigned.worktreeId },
      );
      await expect
        .poll(async () => {
          const response = await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`);
          return ((await response.json()) as { status: string }).status;
        })
        .toBe("running");
      await page.evaluate(
        ({ sessionId, attemptId, worktreeId }) => {
          const socket = (globalThis as typeof globalThis & { errorCodeSocket?: WebSocket })
            .errorCodeSocket;
          if (!socket) throw new Error("host socket missing");
          socket.send(
            JSON.stringify({
              type: "session:status",
              sessionId,
              attemptId,
              worktreeId,
              status: "failed",
              errorCode: "setup_failed",
            }),
          );
        },
        { sessionId, attemptId: assigned.attemptId, worktreeId: assigned.worktreeId },
      );
      await expect
        .poll(async () => {
          const response = await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`);
          return (await response.json()) as {
            status: string;
            errorCode?: string;
            errorMessage?: string;
          };
        })
        .toMatchObject({ status: "failed", errorCode: "setup_failed" });
      const terminal = (await (
        await request.get(`${API_BASE}/api/v1/sessions/${sessionId}`)
      ).json()) as { errorMessage?: string };
      expect(terminal.errorMessage).toBeUndefined();

      await page.goto(`/sessions/${sessionId}`);
      await expect(page.getByTestId("session-detail-error")).toContainText("setup_failed");
      await expect(page.getByTestId("session-detail-error")).toHaveAttribute("role", "alert");
    } finally {
      await page
        .evaluate(() => {
          (
            globalThis as typeof globalThis & { errorCodeSocket?: WebSocket }
          ).errorCodeSocket?.close();
        })
        .catch(() => undefined);
      await request.delete(`${API_BASE}/api/v1/hosts/${hostId}/inventory`).catch(() => undefined);
      if (commandId)
        await request.delete(`${API_BASE}/api/v1/commands/${commandId}`).catch(() => undefined);
    }
  });

  test("unknown session id shows a not-found state", async ({ page }) => {
    await page.goto("/sessions/does-not-exist-xyz");
    await expect(page.getByTestId("page-session-detail-not-found")).toBeVisible();
  });
});
