import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";
import {
  slackTestCredentials as credentials,
  slackTestEncryptor as encryptor,
  slackTestNow as now,
} from "../test-helpers/slack-route-test-helpers.ts";

describe("local Slack OAuth reconnect", () => {
  it("preserves disabled and custom notifications when reconnect omits settings", async () => {
    const notifications = {
      ...DEFAULT_SLACK_NOTIFICATIONS,
      onSessionCreated: false,
      onScheduleCompleted: true,
    };
    const plane = new ControlPlane({ secretEncryptor: encryptor, now: () => now });
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
      slackOAuthClient: {
        exchangeCode: async () => ({
          botToken: "xoxb-1234567890-abcdefghij",
          workspaceId: "T123",
          appId: "A123",
          scopes: ["chat:write", "app_mentions:read", "im:history"],
        }),
        revokeBotToken: async () => undefined,
      },
    });
    const first = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness", enabled: false, notifications },
    );
    expect(first).toMatchObject({ status: 201 });
    const firstState = new URL((first.json as { url: string }).url).searchParams.get("state")!;
    await expect(
      invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${firstState}&code=code`,
      ),
    ).resolves.toMatchObject({ status: 302 });
    expect(plane.state.slackIntegration).toMatchObject({
      enabled: false,
      notifications,
      version: 1,
    });

    const reconnect = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      {
        expectedVersion: 1,
        expectedInstallationId: plane.state.slackIntegration?.installationId,
        defaultChannel: "#reconnected",
      },
    );
    expect(reconnect).toMatchObject({ status: 201 });
    const reconnectState = new URL((reconnect.json as { url: string }).url).searchParams.get(
      "state",
    )!;
    expect(plane.state.slackOAuthStates.values().next().value).toMatchObject({
      expectedVersion: 1,
      enabled: false,
      notifications,
    });
    await expect(
      invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${reconnectState}&code=code`,
      ),
    ).resolves.toMatchObject({ status: 302 });
    expect(plane.state.slackIntegration).toMatchObject({
      defaultChannel: "#reconnected",
      enabled: false,
      notifications,
      version: 2,
    });
  });

  it("rejects a stale reconnect start after delete and recreate", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor, now: () => now });
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
    });
    const first = await plane.installSlackOAuthIntegrationDurable({
      expectedVersion: null,
      defaultChannel: "#harness",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      exchange: {
        botToken: "xoxb-1234567890-abcdefghij",
        workspaceId: "T123",
        appId: "A123",
        scopes: ["chat:write", "app_mentions:read", "im:history"],
      },
    });
    if (!first.ok) throw new Error("initial Slack OAuth install failed");
    const staleInstallationId = plane.state.slackIntegration?.installationId;
    await expect(plane.deleteSlackIntegrationDurable()).resolves.toEqual({ ok: true });
    await expect(
      plane.createSlackIntegrationDurable({
        botToken: "xoxb-1234567890-abcdefghij",
        defaultChannel: "#replacement",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        expectedVersion: 1,
        expectedInstallationId: staleInstallationId,
        defaultChannel: "#stale",
      }),
    ).resolves.toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
    expect(plane.state.slackOAuthStates).toHaveLength(0);
  });
});
