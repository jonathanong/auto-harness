import { expect, test } from "@playwright/test";
import { API_BASE } from "../harness-endpoints.ts";
import { createCatalogRepository } from "../local-1-host.ts";

test("unknown host-pane session id shows a not-found state", async ({ page }) => {
  await page.goto("/sessions/does-not-exist-xyz");
  await expect(page.getByTestId("page-session-detail-not-found")).toBeVisible();
});

test("host-pane session detail reports a live refresh failure", async ({ page, request }) => {
  const suffix = `${test.info().parallelIndex}-${Date.now()}`;
  const command = await request.post(`${API_BASE}/api/v1/commands`, {
    data: { name: `pw-live-error-${suffix}`, argv: ["echo"], appendPrompt: true },
  });
  expect(command.ok()).toBe(true);
  const { id: commandId } = (await command.json()) as { id: string };
  const repositoryId = await createCatalogRepository(request, `pw-live-error-repo-${suffix}`);
  const created = await request.post(`${API_BASE}/api/v1/sessions`, {
    data: {
      repositoryId,
      prompt: "show refresh error",
      target: { commandId },
      timeout: 30,
    },
  });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  await page.route(`**/api/v1/sessions/${encodeURIComponent(id)}`, (route) =>
    route.fulfill({ status: 500, body: "refresh failed" }),
  );

  await page.goto(`/sessions/${encodeURIComponent(id)}`);
  await expect(page.getByTestId("session-live-state-error")).toContainText("refresh paused");
});
