import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";
import {
  slackTestCredentials as credentials,
  slackTestEncryptor as encryptor,
  slackTestNow as now,
} from "../test-helpers/slack-route-test-helpers.ts";

describe("public Slack OAuth start", () => {
  it("fails closed for unavailable credentials and invalid signatures", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor, now: () => now });
    const app = createLocalApp({ plane, authMode: "disabled" });
    expect(
      (
        await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
          defaultChannel: "#harness",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await invokeHandler(
          app.handler,
          "POST",
          "/api/v1/integrations/slack/events",
          {},
          { "x-slack-request-timestamp": "1", "x-slack-signature": `v0=${"0".repeat(64)}` },
        )
      ).status,
    ).toBe(401);
  });

  it("attributes OAuth start to the explicit local principal only in disabled-auth mode", async () => {
    const plane = new ControlPlane({ now: () => now });
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
    });
    expect(
      await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
      }),
    ).toMatchObject({ status: 201 });
    expect(plane.state.slackOAuthStates.values().next().value).toMatchObject({
      principalId: "local:disabled-auth",
    });
    expect(
      await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
        notifications: { unsupported: true },
      }),
    ).toMatchObject({ status: 400 });
  });

  it("waits for a valid deployed URL instead of using the localhost fallback", async () => {
    const plane = new ControlPlane({ now: () => now });
    const resolveSlackOAuthPublicBaseUrl = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("https://d1234.cloudfront.net");
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
      resolveSlackOAuthPublicBaseUrl,
    });

    await expect(
      invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
      }),
    ).resolves.toMatchObject({ status: 503 });
    expect(plane.state.slackOAuthStates).toHaveLength(0);

    const started = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness" },
    );
    expect(started).toMatchObject({ status: 201 });
    expect(new URL((started.json as { url: string }).url).searchParams.get("redirect_uri")).toBe(
      "https://d1234.cloudfront.net/api/v1/integrations/slack/oauth/callback",
    );
    expect(plane.state.slackOAuthStates.values().next().value).toMatchObject({
      publicBaseUrl: "https://d1234.cloudfront.net/",
    });
    expect(resolveSlackOAuthPublicBaseUrl).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-deployment OAuth URL", async () => {
    const app = createLocalApp({
      plane: new ControlPlane({ now: () => now }),
      authMode: "disabled",
      slackAppCredentials: credentials,
      resolveSlackOAuthPublicBaseUrl: async () => "http://localhost:7421",
    });
    await expect(
      invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
      }),
    ).resolves.toMatchObject({ status: 503 });
  });

  it("fails closed when a callback has no usable deployment URL", async () => {
    const app = createLocalApp({
      plane: new ControlPlane({ now: () => now }),
      authMode: "disabled",
      slackAppCredentials: credentials,
      resolveSlackOAuthPublicBaseUrl: async () => undefined,
    });
    await expect(
      invokeHandler(app.handler, "GET", "/api/v1/integrations/slack/oauth/callback"),
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${"a".repeat(32)}&code=code`,
      ),
    ).resolves.toMatchObject({ status: 503 });
  });

  it("accepts callback state created before actor and installation identity snapshots", async () => {
    const plane = new ControlPlane({ now: () => now, secretEncryptor: encryptor });
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
    const started = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness" },
    );
    const state = new URL((started.json as { url: string }).url).searchParams.get("state")!;
    const pending = plane.state.slackOAuthStates.values().next().value;
    delete pending.actor;
    delete pending.expectedInstallationId;

    await expect(
      invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).resolves.toMatchObject({ status: 302 });
    expect(plane.state.slackIntegration).toMatchObject({ installationMethod: "oauth" });
  });

  it("keeps the resolved deployment URL for the OAuth callback exchange and return", async () => {
    const exchangeCode = vi.fn(async () => ({
      botToken: "xoxb-1234567890-abcdefghij",
      workspaceId: "T123",
      appId: "A123",
      scopes: ["chat:write", "app_mentions:read", "im:history"],
    }));
    const resolveSlackOAuthPublicBaseUrl = vi
      .fn()
      .mockResolvedValueOnce("https://d1234.cloudfront.net")
      .mockResolvedValueOnce(undefined);
    const app = createLocalApp({
      plane: new ControlPlane({ now: () => now, secretEncryptor: encryptor }),
      authMode: "disabled",
      slackAppCredentials: credentials,
      resolveSlackOAuthPublicBaseUrl,
      slackOAuthClient: { exchangeCode, revokeBotToken: async () => undefined },
    });
    const started = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness" },
    );
    const state = new URL((started.json as { url: string }).url).searchParams.get("state")!;
    await expect(
      invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).resolves.toMatchObject({ status: 302 });
    expect(exchangeCode).toHaveBeenCalledWith({
      code: "code",
      redirectUri: "https://d1234.cloudfront.net/api/v1/integrations/slack/oauth/callback",
    });
    expect(resolveSlackOAuthPublicBaseUrl).toHaveBeenCalledOnce();
  });
});
