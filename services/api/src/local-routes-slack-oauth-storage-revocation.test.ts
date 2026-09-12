import { expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
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

it("revokes an exchanged token after a durable compare-and-swap leaves it unowned", async () => {
  let storedState: SlackOAuthStateRecord | undefined;
  const plane = new ControlPlane({
    now: () => now,
    publicBaseUrl: "https://harness.example",
    secretEncryptor: encryptor,
    storage: {
      getSlackIntegration: async () => null,
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
  const revokeBotToken = vi.fn(async () => undefined);
  const app = createLocalApp({
    plane,
    authMode: "disabled",
    slackAppCredentials: credentials,
    slackOAuthClient: { exchangeCode: async () => exchange, revokeBotToken },
  });
  const start = await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
    defaultChannel: "#harness",
  });
  const state = new URL((start.json as { url: string }).url).searchParams.get("state")!;

  await expect(
    invokeHandler(
      app.handler,
      "GET",
      `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
    ),
  ).resolves.toMatchObject({ status: 302 });
  expect(revokeBotToken).toHaveBeenCalledExactlyOnceWith(token);
});
