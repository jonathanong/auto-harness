import { expect, test } from "@playwright/test";

import { API_BASE } from "../harness-endpoints.ts";

test.describe("control plane user sessions", () => {
  test("lists a live browser viewer after opening session logs", async ({ page, request }) => {
    await page.goto("/user-sessions");
    await expect(
      page.getByTestId("page-user-sessions").or(page.getByTestId("user-sessions-loading")).first(),
    ).toBeVisible();
    await expect(page.getByTestId("user-sessions-heading")).toHaveText("User Sessions");
    await expect(
      page.getByTestId("user-sessions-empty").or(page.getByTestId("user-sessions-table")),
    ).toBeVisible();
    await expect(page.getByTestId("user-sessions-api-error")).toHaveCount(0);
    await expect(page.getByTestId("user-sessions-api-retry")).toHaveCount(0);

    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const repository = await request.post(`${API_BASE}/api/v1/repositories`, {
      data: {
        name: `pw-user-session-repo-${suffix}`,
        url: `https://git.example.test/pw-user-session-${suffix}.git`,
      },
    });
    expect(repository.status()).toBe(201);
    const repositoryId = ((await repository.json()) as { id: string }).id;
    const command = await request.post(`${API_BASE}/api/v1/commands`, {
      data: { name: `pw-user-session-cmd-${suffix}`, argv: ["echo"], providerId: null },
    });
    expect(command.status()).toBe(201);
    const commandId = ((await command.json()) as { id: string }).id;
    const created = await request.post(`${API_BASE}/api/v1/sessions`, {
      data: {
        repositoryId,
        prompt: `user session ${suffix}`,
        target: { commandId },
        timeout: 30,
      },
    });
    expect(created.status()).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;

    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByTestId("page-session-detail")).toBeVisible();
    await expect(page.getByTestId("session-logs-live-tail")).toBeVisible();

    await page.goto("/user-sessions");
    await expect(page.getByTestId("user-sessions-table")).toBeVisible();
    await expect(page.getByTestId(/^user-session-row-/).first()).toBeVisible();
    await expect(page.getByTestId(/^user-session-user-/).first()).toBeVisible();
    await expect(page.getByTestId(/^user-session-role-/).first()).toBeVisible();
    await expect(page.getByTestId(/^user-session-connected-/).first()).toBeVisible();
    await expect(page.getByTestId(/^user-session-watching-/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: sessionId })).toBeVisible();
    await expect(page.getByTestId(`user-session-watch-${sessionId}`)).toBeVisible();
  });
});
