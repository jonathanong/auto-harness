import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { AuthService } from "./auth.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const now = "2026-09-12T00:00:00.000Z";
const signingSecret = "a".repeat(32);
const credentials = { clientId: "client", clientSecret: "client-secret", signingSecret };

const encryptor: SecretEncryptor = {
  encrypt: async (value) => value,
  decrypt: async (value) => value,
};

function adminAuth(): AuthService {
  return new AuthService({
    mode: "required",
    secret: "a".repeat(32),
    admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
      "base64url",
    ),
  });
}

function basic(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from("root:root").toString("base64")}` };
}

function sign(body: unknown): Record<string, string> {
  const timestamp = String(Math.floor(Date.parse(now) / 1000));
  const raw = JSON.stringify(body);
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`,
  };
}

describe("public Slack OAuth and events routes", () => {
  it("installs with one-time state and durably accepts a signed matching-workspace event once", async () => {
    const plane = new ControlPlane({
      secretEncryptor: encryptor,
      now: () => now,
      publicBaseUrl: "https://harness.example",
    });
    const auth = adminAuth();
    const app = createLocalApp({
      plane,
      authService: auth,
      slackAppCredentials: credentials,
      slackOAuthClient: {
        exchangeCode: async () => ({
          botToken: "xoxb-1234567890-abcdefghij",
          workspaceId: "T123",
          workspaceName: "Workspace",
          appId: "A123",
          botUserId: "Ubot",
          scopes: ["chat:write", "app_mentions:read", "im:history"],
        }),
        revokeBotToken: async () => undefined,
      },
    });
    expect(
      (
        await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
          defaultChannel: "#harness",
        })
      ).status,
    ).toBe(401);
    const start = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/oauth/start",
      { defaultChannel: "#harness" },
      basic(),
    );
    expect(start).toMatchObject({ status: 201, json: { url: expect.stringContaining("state=") } });
    const state = new URL((start.json as { url: string }).url).searchParams.get("state")!;
    expect(
      (
        await invokeHandler(
          app.handler,
          "GET",
          `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
        )
      ).status,
    ).toBe(302);
    expect(plane.state.slackIntegration).toMatchObject({
      installationMethod: "oauth",
      workspaceId: "T123",
      grantedScopes: ["chat:write", "app_mentions:read", "im:history"],
    });
    const integration = await invokeHandler(
      app.handler,
      "GET",
      "/api/v1/integrations/slack",
      undefined,
      basic(),
    );
    expect(integration).toMatchObject({ status: 200, json: { inboundAvailable: true } });
    expect(
      await invokeHandler(
        createLocalApp({ plane, authService: auth }).handler,
        "GET",
        "/api/v1/integrations/slack",
        undefined,
        basic(),
      ),
    ).toMatchObject({ status: 200, json: { inboundAvailable: false } });
    expect(
      (
        await invokeHandler(
          app.handler,
          "GET",
          `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
        )
      ).status,
    ).toBe(302);

    const event = {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A123",
      event_id: "Ev1",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1.0" },
    };
    expect(
      (
        await invokeHandler(
          app.handler,
          "POST",
          "/api/v1/integrations/slack/events",
          event,
          sign(event),
        )
      ).status,
    ).toBe(200);
    expect(plane.state.slackInboundEvents.size).toBe(1);
    expect(
      (
        await invokeHandler(
          app.handler,
          "POST",
          "/api/v1/integrations/slack/events",
          event,
          sign(event),
        )
      ).status,
    ).toBe(200);
    const wrongWorkspace = { ...event, team_id: "T999", event_id: "Ev2" };
    expect(
      (
        await invokeHandler(
          app.handler,
          "POST",
          "/api/v1/integrations/slack/events",
          wrongWorkspace,
          sign(wrongWorkspace),
        )
      ).status,
    ).toBe(401);
  });
});
