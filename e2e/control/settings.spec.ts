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
  test("renders redacted state and supports create, replace, and delete", async ({ page }) => {
    let configured = false;
    await page.route("**/api/v1/integrations/slack", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill(
          configured
            ? { status: 200, json: publicConfig }
            : { status: 404, json: { error: { code: "NOT_FOUND" } } },
        );
        return;
      }
      if (method === "POST" || method === "PUT") {
        configured = true;
        await route.fulfill({ status: method === "POST" ? 201 : 200, json: publicConfig });
        return;
      }
      configured = false;
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/settings");
    await page.getByTestId("nav-group-settings").click();
    await expect(page.getByTestId("nav-settings")).toBeVisible();
    await expect(page.getByTestId("page-settings")).toBeVisible();
    await expect(page.getByTestId("settings-heading")).toHaveText("Settings");
    await expect(page.getByTestId("slack-settings-section")).toBeVisible();
    await expect(page.getByTestId("slack-settings-card")).toBeVisible();
    await expect(page.getByTestId("slack-bot-token-state")).toHaveText("Not configured");
    await expect(page.getByTestId("slack-signing-secret-state")).toHaveText("Not configured");
    await expect(page.getByTestId("slack-configured-state")).toBeVisible();
    await expect(page.getByTestId("slack-default-channel-state")).toHaveText("—");
    await expect(page.getByTestId("slack-enabled-state")).toHaveText("No");
    await expect(page.getByTestId("slack-delivery-warning")).toContainText(
      "Configuration alone does not send Slack messages",
    );
    await expect(page.getByTestId("form-slack-create")).toBeVisible();
    await expect(page.getByTestId("slack-default-channel")).toHaveValue("#harness");
    await expect(page.getByTestId("slack-enabled")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionCreated")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionStarted")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionCompleted")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionFailed")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionCancelled")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onScheduleCompleted")).not.toBeChecked();

    await page.getByTestId("slack-bot-token").fill("not-a-token");
    await page.getByTestId("slack-submit").click();
    await expect(page.getByTestId("slack-error")).toContainText("xoxb-");

    await page.getByTestId("slack-bot-token").fill("xoxb-1234567890-create-secret");
    await page.getByTestId("slack-signing-secret").fill("a".repeat(32));
    await page.getByTestId("slack-submit").click();
    await expect(page.getByTestId("slack-ok")).toContainText("saved");
    await expect(page.getByTestId("slack-bot-token")).toHaveValue("");
    await expect(page.getByTestId("slack-signing-secret")).toHaveValue("");
    await expect(page.getByTestId("form-slack-replace")).toBeVisible();
    await expect(page.getByTestId("slack-replace-help")).toBeVisible();
    await expect(page.getByTestId("slack-default-channel-state")).toHaveText("#harness");
    await expect(page.getByTestId("slack-enabled-state")).toHaveText("Yes");

    await page.getByTestId("slack-bot-token").fill("xoxb-1234567890-replacement");
    await page.getByTestId("slack-submit").click();
    await expect(page.getByTestId("slack-ok")).toContainText("saved");
    await page.getByTestId("slack-delete").click();
    await expect(page.getByTestId("slack-delete-confirm")).toBeVisible();
    await page.getByTestId("slack-delete-confirm-submit").click();
    await expect(page.getByTestId("slack-ok")).toContainText("deleted");
    await expect(page.getByTestId("slack-bot-token-state")).toHaveText("Not configured");
  });

  test("shows loading until settings resolve", async ({ page }) => {
    let release: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/integrations/slack", async (route) => {
      await pending;
      await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    });

    await page.goto("/settings");
    await expect(page.getByTestId("slack-settings-loading")).toHaveAttribute("aria-busy", "true");
    release!();
    await expect(page.getByTestId("page-settings")).toBeVisible();
  });

  test("shows a permission error while preserving account settings navigation", async ({
    page,
  }) => {
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN" } } }),
    );

    await page.goto("/settings");
    await expect(page.getByTestId("slack-settings-forbidden")).toBeVisible();
    await expect(page.getByTestId("settings-forbidden-error")).toContainText("permission");
    await page.getByTestId("nav-group-settings").click();
    await expect(page.getByTestId("nav-settings")).toBeVisible();
  });

  test("shows a load error when the settings API is unavailable", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL" } } }),
    );

    await page.goto("/settings");
    await expect(page.getByTestId("slack-settings-error")).toBeVisible();
    await expect(page.getByTestId("settings-load-error")).toContainText("Unable to load");
  });

  test("redirects 401 to login with a relative return path", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({ status: 401, body: "authentication required" }),
    );
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings$/);
  });
});
