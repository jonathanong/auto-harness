import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const now = "2026-09-12T00:00:00.000Z";
const credentials = {
  clientId: "client",
  clientSecret: "client-secret",
  signingSecret: "a".repeat(32),
};
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

async function start(app: ReturnType<typeof createLocalApp>["handler"]): Promise<string> {
  const response = await invokeHandler(
    app,
    "POST",
    "/api/v1/integrations/slack/oauth/start",
    { defaultChannel: "#harness" },
    basic(),
  );
  return new URL((response.json as { url: string }).url).searchParams.get("state")!;
}

function callbackAudits(plane: ControlPlane) {
  return [...plane.state.auditLogs.values()].filter(
    (event) => event.action === "integration:slack:oauth:callback",
  );
}

describe("Slack OAuth callback audit attribution", () => {
  it("attributes a successful callback to the initiating admin", async () => {
    const plane = new ControlPlane({
      secretEncryptor: encryptor,
      now: () => now,
      publicBaseUrl: "https://harness.example",
    });
    const app = createLocalApp({
      plane,
      authService: adminAuth(),
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
    const state = await start(app.handler);

    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).toMatchObject({ status: 302 });
    expect(callbackAudits(plane)).toEqual([
      expect.objectContaining({
        actor: { id: "admin:root", kind: "admin", role: "admin" },
        outcome: "success",
      }),
    ]);
  });

  it("attributes a failure after state consumption to the initiating admin", async () => {
    const plane = new ControlPlane({ now: () => now, publicBaseUrl: "https://harness.example" });
    const app = createLocalApp({
      plane,
      authService: adminAuth(),
      slackAppCredentials: credentials,
      slackOAuthClient: {
        exchangeCode: async () => {
          throw new Error("exchange failed");
        },
        revokeBotToken: async () => undefined,
      },
    });
    const state = await start(app.handler);

    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).toMatchObject({ status: 302 });
    expect(plane.state.slackOAuthStates).toHaveLength(0);
    expect(callbackAudits(plane)).toEqual([
      expect.objectContaining({
        actor: { id: "admin:root", kind: "admin", role: "admin" },
        outcome: "failed",
      }),
    ]);
  });

  it("consumes valid OAuth state when Slack denies authorization", async () => {
    const exchangeCode = vi.fn(async () => ({
      botToken: "xoxb-1234567890-abcdefghij",
      workspaceId: "T123",
      appId: "A123",
      scopes: ["chat:write", "app_mentions:read", "im:history"],
    }));
    const plane = new ControlPlane({
      now: () => now,
      publicBaseUrl: "https://harness.example",
      secretEncryptor: encryptor,
    });
    const app = createLocalApp({
      plane,
      authService: adminAuth(),
      slackAppCredentials: credentials,
      slackOAuthClient: { exchangeCode, revokeBotToken: async () => undefined },
    });
    const state = await start(app.handler);

    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&error=access_denied`,
      ),
    ).toMatchObject({ status: 302 });
    expect(plane.state.slackOAuthStates).toHaveLength(0);

    await expect(
      invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).resolves.toMatchObject({ status: 302 });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(plane.state.slackIntegration).toBeUndefined();
    expect(callbackAudits(plane)).toEqual([
      expect.objectContaining({
        actor: { id: "admin:root", kind: "admin", role: "admin" },
        outcome: "failed",
      }),
    ]);
  });
});
