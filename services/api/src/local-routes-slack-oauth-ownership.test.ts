import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { resolveSlackBotToken } from "./slack-secrets.ts";
import type { SlackOAuthExchange, SlackOAuthStateRecord } from "./slack-oauth-types.ts";
import {
  slackTestCredentials as credentials,
  slackTestNow as now,
} from "../test-helpers/slack-route-test-helpers.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const token = "xoxb-1234567890-abcdefghij";
const exchange: SlackOAuthExchange = {
  botToken: token,
  workspaceId: "T123",
  appId: "A123",
  scopes: ["chat:write", "app_mentions:read", "im:history"],
};
const encryptor: SecretEncryptor = {
  encrypt: async (value) => value,
  decrypt: async (value) => value,
};

function appFor(plane: ControlPlane, revokeBotToken = vi.fn(async () => undefined)) {
  return {
    app: createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
      slackOAuthClient: { exchangeCode: async () => exchange, revokeBotToken },
    }),
    revokeBotToken,
  };
}

async function start(
  app: ReturnType<typeof createLocalApp>["handler"],
  input: Record<string, unknown>,
): Promise<string> {
  const result = await invokeHandler(app, "POST", "/api/v1/integrations/slack/oauth/start", {
    defaultChannel: "#harness",
    ...input,
  });
  expect(result.status).toBe(201);
  return new URL((result.json as { url: string }).url).searchParams.get("state")!;
}

async function callback(
  app: ReturnType<typeof createLocalApp>["handler"],
  state: string,
): ReturnType<typeof invokeHandler> {
  return invokeHandler(
    app,
    "GET",
    `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
  );
}

describe("Slack OAuth callback token ownership", () => {
  it("retains an exchanged token that a concurrent settings update still owns", async () => {
    const plane = new ControlPlane({
      now: () => now,
      publicBaseUrl: "https://harness.example",
      secretEncryptor: encryptor,
    });
    await plane.installSlackOAuthIntegrationDurable({
      expectedVersion: null,
      defaultChannel: "#harness",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      exchange,
    });
    const { app, revokeBotToken } = appFor(plane);
    const state = await start(app.handler, {
      expectedVersion: 1,
      expectedInstallationId: plane.state.slackIntegration?.installationId,
    });
    await plane.patchSlackIntegrationDurable({ expectedVersion: 1, defaultChannel: "#changed" });

    await expect(callback(app.handler, state)).resolves.toMatchObject({ status: 302 });
    expect(revokeBotToken).not.toHaveBeenCalled();
    expect(plane.state.slackIntegration).toMatchObject({ version: 2, defaultChannel: "#changed" });
    await expect(resolveSlackBotToken(encryptor, plane.state.slackIntegration!)).resolves.toBe(
      token,
    );
  });

  it("does not revoke when a durable ownership read fails", async () => {
    let storedState: SlackOAuthStateRecord | undefined;
    let failReads = false;
    const plane = new ControlPlane({
      now: () => now,
      publicBaseUrl: "https://harness.example",
      secretEncryptor: encryptor,
      storage: {
        getSlackIntegration: async () => {
          if (failReads) throw new Error("Dynamo unavailable");
          return null;
        },
        putSlackIntegration: async () => false,
        putSlackOAuthState: async (state) => {
          storedState = state;
          return true;
        },
        consumeSlackOAuthState: async () => {
          const consumed = storedState;
          storedState = undefined;
          return consumed ?? null;
        },
        putAuditLog: async () => undefined,
      } as never,
    });
    const { app, revokeBotToken } = appFor(plane);
    const state = await start(app.handler, { expectedVersion: null });
    failReads = true;

    await expect(callback(app.handler, state)).resolves.toMatchObject({ status: 302 });
    expect(revokeBotToken).not.toHaveBeenCalled();
  });

  it("does not revoke when durable token decryption fails", async () => {
    const plane = new ControlPlane({
      now: () => now,
      publicBaseUrl: "https://harness.example",
      secretEncryptor: encryptor,
    });
    await plane.installSlackOAuthIntegrationDurable({
      expectedVersion: null,
      defaultChannel: "#harness",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      exchange,
    });
    const { app, revokeBotToken } = appFor(plane);
    const state = await start(app.handler, {
      expectedVersion: 1,
      expectedInstallationId: plane.state.slackIntegration?.installationId,
    });
    await plane.patchSlackIntegrationDurable({ expectedVersion: 1, defaultChannel: "#changed" });
    plane.state.secretEncryptor = {
      ...encryptor,
      decrypt: async () => Promise.reject(new Error("KMS unavailable")),
    };

    await expect(callback(app.handler, state)).resolves.toMatchObject({ status: 302 });
    expect(revokeBotToken).not.toHaveBeenCalled();
  });
});
