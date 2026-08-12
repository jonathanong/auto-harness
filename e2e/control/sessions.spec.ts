/* eslint-disable max-lines, no-shadow -- the end-to-end WebSocket reporting flow stays in one auditable scenario. */
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
    await expect(page.getByTestId("session-new-heading")).toHaveText("New session");
    await expect(page.getByTestId("form-create-session")).toBeVisible();
    await expect(page.getByTestId("create-session-repository-id")).toBeVisible();
    await expect(page.getByTestId("create-session-prompt")).toBeVisible();
    await expect(page.getByTestId("create-session-timeout")).toBeVisible();
    await expect(page.getByTestId("create-session-ref")).toBeVisible();
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
        await expect(page.getByTestId("create-session-error")).toHaveCount(0);

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
      const provider = await request.post("http://127.0.0.1:7430/api/v1/providers", {
        data: {
          name: providerName,
          usageRates: { currency: "USD", inputTokenMicros: "2" },
        },
      });
      expect(provider.ok()).toBe(true);
      providerId = ((await provider.json()) as { id: string }).id;

      const account = await request.post("http://127.0.0.1:7430/api/v1/provider-accounts", {
        data: { providerId, label: `${providerName}@example.com` },
      });
      expect(account.ok()).toBe(true);
      accountId = ((await account.json()) as { id: string }).id;

      const command = await request.post("http://127.0.0.1:7430/api/v1/commands", {
        data: { name: `${providerName}-command`, argv: ["echo"], providerId },
      });
      expect(command.ok()).toBe(true);
      commandId = ((await command.json()) as { id: string }).id;

      const inventory = await request.put(
        `http://127.0.0.1:7430/api/v1/hosts/${hostId}/inventory`,
        {
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
        },
      );
      expect(inventory.ok()).toBe(true);

      // Connect from the control-plane origin (rather than an opaque blank-page
      // origin) to exercise the same browser WebSocket policy as the real UI.
      await page.goto("/sessions");
      await page.evaluate(
        ({ hostId, repoId, worktreeId }) =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket("ws://127.0.0.1:7430/ws");
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
        { hostId, repoId, worktreeId },
      );

      const created = await request.post("http://127.0.0.1:7430/api/v1/sessions", {
        data: { repositoryId: repoId, prompt: "report usage", target: { commandId }, timeout: 30 },
      });
      expect(created.status()).toBe(201);
      const sessionId = ((await created.json()) as { id: string }).id;
      expect((await request.post("http://127.0.0.1:7430/api/v1/scheduler/assign")).ok()).toBe(true);

      const assigned = await request.get(`http://127.0.0.1:7430/api/v1/sessions/${sessionId}`);
      expect(assigned.ok()).toBe(true);
      const session = (await assigned.json()) as { attemptId: string; worktreeId: string };
      await page.evaluate(
        ({ sessionId, attemptId, worktreeId }) => {
          const socket = (globalThis as typeof globalThis & { usageSocket?: WebSocket })
            .usageSocket;
          if (!socket) throw new Error("host socket missing");
          socket.send(JSON.stringify({ type: "session:ack", sessionId, attemptId, worktreeId }));
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
          const usage = await request.get(
            `http://127.0.0.1:7430/api/v1/sessions/${sessionId}/usage`,
          );
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
      await request
        .delete(`http://127.0.0.1:7430/api/v1/hosts/${hostId}/inventory`)
        .catch(() => undefined);
      if (commandId)
        await request
          .delete(`http://127.0.0.1:7430/api/v1/commands/${commandId}`)
          .catch(() => undefined);
      if (accountId)
        await request
          .delete(`http://127.0.0.1:7430/api/v1/provider-accounts/${accountId}`)
          .catch(() => undefined);
      if (providerId)
        await request
          .delete(`http://127.0.0.1:7430/api/v1/providers/${providerId}`)
          .catch(() => undefined);
    }
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
