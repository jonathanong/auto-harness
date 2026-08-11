import { expect, test } from "@playwright/test";

const publicConfig = {
  id: "slack",
  type: "slack",
  defaultChannel: "#harness",
  enabled: true,
  notifications: {
    onSessionCreated: true,
    onSessionStarted: true,
    onSessionCompleted: true,
    onSessionFailed: true,
    onSessionCancelled: true,
    onScheduleCompleted: false,
  },
  botTokenConfigured: true,
  signingSecretConfigured: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test.describe("control plane Slack settings", () => {
  test("sends unauthenticated users through the safe login return path", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", async (route) => {
      await route.fulfill({ status: 401, body: "authentication required" });
    });
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings$/);
  });

  test("shows a safe actionable error when saving cannot reach the API", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        return;
      }
      await route.abort("failed");
    });
    await page.goto("/settings");
    await page.getByTestId("slack-bot-token").fill("xoxb-transport-secret");
    await page.getByTestId("slack-submit").click();
    await expect(page.getByTestId("slack-error")).toHaveText(
      "Unable to save Slack configuration. Try again.",
    );
    await expect(page.getByTestId("slack-error")).not.toContainText("transport-secret");
  });

  test("renders an accessible permission error for a forbidden admin surface", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", async (route) => {
      await route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN" } } });
    });
    await page.goto("/settings");
    await expect(page.getByTestId("page-settings-forbidden")).toBeVisible();
    await expect(page.getByTestId("settings-forbidden-error")).toHaveAttribute("role", "alert");
  });

  test("renders an accessible load error when settings cannot be read", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", async (route) => {
      await route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    });
    await page.goto("/settings");
    await expect(page.getByTestId("page-settings-error")).toBeVisible();
    await expect(page.getByTestId("settings-load-error")).toHaveAttribute("role", "alert");
  });

  test("creates, replaces, and deletes Slack configuration without echoing secrets", async ({
    page,
  }) => {
    await page.route("**/api/v1/integrations/slack", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        return;
      }
      if (route.request().method() === "POST" || route.request().method() === "PUT") {
        await route.fulfill({
          status: route.request().method() === "POST" ? 201 : 200,
          json: publicConfig,
        });
        return;
      }
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/settings");
    await expect(page.getByTestId("page-settings")).toBeVisible();
    await expect(page.getByTestId("settings-heading")).toHaveText("Settings");
    await expect(page.getByTestId("slack-settings-card")).toBeVisible();
    await expect(page.getByTestId("slack-delivery-warning")).toContainText(
      "Configuration alone does not send Slack messages",
    );
    await expect(page.getByTestId("slack-configured-state")).toBeVisible();
    await expect(page.getByTestId("slack-bot-token-state")).toHaveText("Not configured");
    await expect(page.getByTestId("slack-signing-secret-state")).toHaveText("Not configured");
    await expect(page.getByTestId("slack-default-channel-state")).toHaveText("—");
    await expect(page.getByTestId("slack-enabled-state")).toHaveText("No");

    await page.getByTestId("slack-bot-token").fill("not-a-token");
    await page.getByTestId("slack-submit").click();
    await expect(page.getByTestId("slack-error")).toContainText("xoxb-");

    await page.getByTestId("slack-bot-token").fill("xoxb-create-secret");
    await page.getByTestId("slack-signing-secret").fill("create-signing-secret");
    await page.getByTestId("slack-default-channel").fill("#harness");
    for (const name of [
      "onSessionCreated",
      "onSessionStarted",
      "onSessionCompleted",
      "onSessionFailed",
      "onSessionCancelled",
      "onScheduleCompleted",
    ]) {
      await expect(page.getByTestId(`slack-notification-${name}`)).toBeVisible();
    }
    await page.getByTestId("slack-notification-onScheduleCompleted").check();
    await page.getByTestId("slack-submit").click();
    await expect(page.getByTestId("slack-ok")).toContainText("saved");
    await expect(page.getByTestId("slack-bot-token-state")).toHaveText("Configured");
    await expect(page.getByTestId("slack-bot-token")).toHaveValue("");
    await expect(page.getByTestId("slack-signing-secret")).toHaveValue("");

    await expect(page.getByTestId("form-slack-replace")).toBeVisible();
    await expect(page.getByTestId("slack-replace-help")).toContainText("enter the bot token again");
    await page.getByTestId("slack-bot-token").fill("xoxb-replacement-secret");
    await page.getByTestId("slack-default-channel").fill("C0123ABCDE");
    await page.getByTestId("slack-enabled").uncheck();
    await page.getByTestId("slack-submit").click();
    await expect(page.getByTestId("slack-ok")).toContainText("saved");
    await expect(page.getByTestId("slack-bot-token")).toHaveValue("");

    await page.getByTestId("slack-delete").click();
    await expect(page.getByTestId("slack-delete-confirm")).toBeVisible();
    await expect(page.getByTestId("slack-delete-confirm")).toContainText("cannot be undone");
    await page.getByTestId("slack-delete-confirm-submit").click();
    await expect(page.getByTestId("slack-ok")).toContainText("deleted");
    await expect(page.getByTestId("slack-bot-token-state")).toHaveText("Not configured");
  });
});
