import { expect, test } from "@playwright/test";

test.describe("control plane custom webhook settings", () => {
  test("creates a structured inbound webhook configuration", async ({ page }) => {
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/v1/integrations/custom/deploy", async (route) => {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        json: {
          id: "deploy",
          type: "custom-webhook",
          ...submitted,
          secretConfigured: true,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });

    await page.goto("/settings/custom-webhooks");
    await expect(page.getByTestId("custom-webhook-settings-card")).toBeVisible();
    await page.getByTestId("custom-webhook-id").fill("deploy");
    await page.getByTestId("custom-webhook-queue-ttl").fill("3600");
    await page.getByTestId("custom-webhook-priority").fill("5");
    await page.getByTestId("custom-webhook-repository").fill("repo-1");
    await page.getByTestId("custom-webhook-target-type").selectOption("commandId");
    await page.getByTestId("custom-webhook-target").fill("command-1");
    await page.getByTestId("custom-webhook-timeout").fill("120");
    await page.getByTestId("custom-webhook-secret").fill("a-high-entropy-secret");
    await page.getByTestId("custom-webhook-submit").click();

    await expect(page.getByTestId("custom-webhook-success")).toContainText("saved");
    expect(submitted).toMatchObject({
      repositoryId: "repo-1",
      target: { commandId: "command-1" },
      queueTtlSeconds: 3600,
      timeout: 120,
      priority: 5,
      secret: "a-high-entropy-secret",
    });
  });
});
