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
    onHostOffline: true,
  },
  botTokenConfigured: true,
  signingSecretConfigured: true,
  installationMethod: "manual",
  inboundAvailable: true,
  workspaceId: "T01234567",
  workspaceName: "Harness",
  appId: "A01234567",
  grantedScopes: ["chat:write"],
  deliveryAvailable: false,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

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

    await page.goto("/settings/slack");
    await page.getByTestId("nav-group-settings").click();
    await expect(page.getByTestId("nav-slack")).toBeVisible();
    await page.keyboard.press("Escape");
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
      "Messages are sent only when outbound delivery is available",
    );
    await expect(page.getByTestId("slack-delivery-state")).toHaveText("Not configured");
    await expect(page.getByTestId("slack-connection-options")).toBeVisible();
    await expect(page.getByTestId("slack-connect")).toBeVisible();
    await expect(page.getByTestId("slack-manual-path")).toBeVisible();
    await expect(page.getByTestId("form-slack-create")).toBeVisible();
    await expect(page.getByTestId("slack-default-channel")).toHaveValue("#harness");
    await expect(page.getByTestId("slack-enabled")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionCreated")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionStarted")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionCompleted")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionFailed")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onSessionCancelled")).toBeChecked();
    await expect(page.getByTestId("slack-notification-onScheduleCompleted")).not.toBeChecked();
    await expect(page.getByTestId("slack-notification-onHostOffline")).toBeChecked();

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

    await page.goto("/settings/slack");
    await expect(page.getByTestId("slack-settings-loading")).toHaveAttribute("aria-busy", "true");
    release!();
    await expect(page.getByTestId("page-settings")).toBeVisible();
  });

  test("keeps OAuth reconnect and ordinary settings separate", async ({ page }) => {
    let startBody: Record<string, unknown> | undefined;
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({
        status: 200,
        json: {
          ...publicConfig,
          installationMethod: "oauth",
          inboundAvailable: true,
          grantedScopes: ["chat:write", "app_mentions:read", "im:history"],
        },
      }),
    );
    await page.route("**/api/v1/integrations/slack/oauth/start", async (route) => {
      startBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        json: { url: "https://slack.com/oauth/v2/authorize?state=test" },
      });
    });
    await page.route("https://slack.com/oauth/v2/authorize**", (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "oauth" }),
    );

    await page.goto("/settings/slack");
    await expect(page.getByTestId("slack-reconnect")).toBeVisible();
    await expect(page.getByTestId("slack-installation-method-state")).toHaveText("OAuth");
    await expect(page.getByTestId("slack-workspace-state")).toContainText("Harness");
    await expect(page.getByTestId("slack-app-state")).toHaveText("A01234567");
    await expect(page.getByTestId("slack-inbound-state")).toHaveText("Available");
    await expect(page.getByTestId("slack-scopes-state")).toContainText("app_mentions:read");
    await expect(page.getByTestId("form-slack-settings")).toBeVisible();
    await expect(page.getByTestId("form-slack-manual-replace")).toBeVisible();
    await expect(page.getByTestId("slack-bot-token")).toBeVisible();
    await expect(page.getByTestId("slack-manual-submit")).toBeVisible();
    await page.getByTestId("slack-bot-token").fill("not-a-token");
    await page.getByTestId("slack-manual-submit").click();
    await expect(page.getByTestId("slack-manual-error")).toContainText("xoxb-");
    await page.getByTestId("slack-reconnect").click();
    await expect
      .poll(() => startBody)
      .toMatchObject({
        defaultChannel: "#harness",
        expectedVersion: 1,
      });
  });

  test("shows safe OAuth callback status and strips unknown values", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } }),
    );
    await page.goto("/settings?slackOAuth=success");
    await expect(page.getByTestId("slack-oauth-status")).toContainText("Slack connected");
    await expect(page).toHaveURL("/settings/slack");
    await page.goto("/settings/slack?slackOAuth=unexpected");
    await expect(page).toHaveURL("/settings/slack");
    await expect(page.getByTestId("slack-oauth-status")).toHaveCount(0);
  });

  test("shows a permission error while preserving account settings navigation", async ({
    page,
  }) => {
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN" } } }),
    );

    await page.goto("/settings/slack");
    await expect(page.getByTestId("slack-settings-forbidden")).toBeVisible();
    await expect(page.getByTestId("settings-forbidden-error")).toContainText("permission");
    await page.getByTestId("nav-group-settings").click();
    await expect(page.getByTestId("nav-slack")).toBeVisible();
  });

  test("shows a load error when the settings API is unavailable", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL" } } }),
    );

    await page.goto("/settings/slack");
    await expect(page.getByTestId("slack-settings-error")).toBeVisible();
    await expect(page.getByTestId("settings-load-error")).toContainText("Unable to load");
  });

  test("redirects 401 to login with a relative return path", async ({ page }) => {
    await page.route("**/api/v1/integrations/slack", (route) =>
      route.fulfill({ status: 401, body: "authentication required" }),
    );
    await page.goto("/settings/slack");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings%2Fslack$/);
  });
});
