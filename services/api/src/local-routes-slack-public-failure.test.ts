import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import {
  handlePublicSlackRoutes,
  handleSlackOAuthStartRoute,
} from "./local-routes-slack-public.ts";
import {
  slackTestCredentials as credentials,
  slackTestEncryptor as encryptor,
  slackTestNow as now,
} from "../test-helpers/slack-route-test-helpers.ts";
import { invokeBadJson, invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const exchangeCode = async () => ({
  botToken: "xoxb-1234567890-abcdefghij",
  workspaceId: "T123",
  appId: "A123",
  scopes: ["chat:write"],
});

describe("Slack OAuth route failures", () => {
  it("fails closed when credentials, JSON, or settings are invalid", async () => {
    const app = createLocalApp({
      plane: new ControlPlane({ now: () => now }),
      authMode: "disabled",
    });
    expect(
      await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
      }),
    ).toMatchObject({ status: 503, json: { error: { code: "UNAVAILABLE" } } });

    const configured = createLocalApp({
      plane: new ControlPlane({ now: () => now }),
      authMode: "disabled",
      slackAppCredentials: credentials,
    });
    for (const value of [
      null,
      [],
      { defaultChannel: "#harness", extra: true },
      { defaultChannel: "not-a-channel" },
      { defaultChannel: "#harness", expectedVersion: 0 },
      { defaultChannel: "#harness", expectedVersion: 1.5 },
      { defaultChannel: "#harness", enabled: "yes" },
      { defaultChannel: "#harness", notifications: [] },
      { defaultChannel: "#harness", notifications: { unsupported: true } },
      { defaultChannel: "#harness", notifications: { onSessionCreated: "yes" } },
    ]) {
      expect(
        await invokeHandler(
          configured.handler,
          "POST",
          "/api/v1/integrations/slack/oauth/start",
          value,
        ),
      ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    }
    expect(
      await invokeBadJson(configured.handler, "POST", "/api/v1/integrations/slack/oauth/start"),
    ).toBe(400);
  });

  it("accepts channel IDs and preserves explicit settings", async () => {
    const plane = new ControlPlane({ now: () => now });
    const app = createLocalApp({ plane, authMode: "disabled", slackAppCredentials: credentials });
    expect(
      await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "G123456789",
        expectedVersion: 2,
        enabled: false,
        notifications: { onSessionCreated: false },
      }),
    ).toMatchObject({ status: 201 });
    expect(plane.state.slackOAuthStates.values().next().value).toMatchObject({
      expectedVersion: 2,
      enabled: false,
      notifications: { onSessionCreated: false },
    });
  });

  it("fails closed for invalid, consumed, and exchange-failing callbacks", async () => {
    const plane = new ControlPlane({ now: () => now, publicBaseUrl: "https://harness.example" });
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
      slackOAuthClient: {
        exchangeCode: async () => {
          throw new Error("exchange");
        },
        revokeBotToken: async () => undefined,
      },
    });
    for (const path of [
      "/api/v1/integrations/slack/oauth/callback",
      "/api/v1/integrations/slack/oauth/callback?state=short&code=code",
      `/api/v1/integrations/slack/oauth/callback?state=${"a".repeat(32)}&code=`,
      `/api/v1/integrations/slack/oauth/callback?state=${"a".repeat(32)}&code=${"x".repeat(4097)}`,
    ])
      expect(await invokeHandler(app.handler, "GET", path)).toMatchObject({ status: 302 });
    const start = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness" },
    );
    const state = new URL((start.json as { url: string }).url).searchParams.get("state")!;
    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).toMatchObject({ status: 302 });
  });

  it("surfaces persistence failures and installation version conflicts", async () => {
    const failed = new ControlPlane({ now: () => now });
    failed.state.storage = {
      putSlackOAuthState: async () => false,
      putAuditLog: async () => undefined,
    } as never;
    const failedApp = createLocalApp({
      plane: failed,
      authMode: "disabled",
      slackAppCredentials: credentials,
    });
    expect(
      await invokeHandler(failedApp.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
      }),
    ).toMatchObject({ status: 500 });

    const plane = new ControlPlane({ now: () => now, secretEncryptor: encryptor });
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
      slackOAuthClient: { exchangeCode, revokeBotToken: async () => undefined },
    });
    const start = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness" },
    );
    const state = new URL((start.json as { url: string }).url).searchParams.get("state")!;
    await invokeHandler(
      app.handler,
      "GET",
      `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
    );
    const reconnect = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness" },
    );
    const reconnectState = new URL((reconnect.json as { url: string }).url).searchParams.get(
      "state",
    )!;
    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${reconnectState}&code=code`,
      ),
    ).toMatchObject({ status: 302 });
  });

  it("does not dispatch unrelated methods or paths", async () => {
    const plane = new ControlPlane({ now: () => now });
    expect(
      await handlePublicSlackRoutes(
        { plane, method: "GET", url: new URL("http://localhost/other") } as never,
        {},
      ),
    ).toBe(false);
    expect(
      await handleSlackOAuthStartRoute(
        { plane, method: "GET", url: new URL("http://localhost/other") } as never,
        { credentials },
      ),
    ).toBe(false);
  });
});
