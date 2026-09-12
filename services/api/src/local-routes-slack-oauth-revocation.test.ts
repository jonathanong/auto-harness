import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackOAuthExchange } from "./slack-oauth-types.ts";
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

function newPlane(secretEncryptor?: SecretEncryptor): ControlPlane {
  return new ControlPlane({
    now: () => now,
    ...(secretEncryptor ? { secretEncryptor } : {}),
  });
}

type ConfiguredCase = {
  plane: ControlPlane;
  exchangeCode?: () => Promise<SlackOAuthExchange>;
  startInput?: Record<string, unknown>;
  afterStart?: (plane: ControlPlane) => Promise<void>;
};

type RejectedInstallationCase = {
  name: string;
  expectedRevocation?: boolean;
  create: () => Promise<ConfiguredCase>;
};

async function install(state: ControlPlane, installation: SlackOAuthExchange): Promise<void> {
  await state.installSlackOAuthIntegrationDurable({
    expectedVersion: null,
    defaultChannel: "#harness",
    enabled: true,
    notifications: DEFAULT_SLACK_NOTIFICATIONS,
    exchange: installation,
  });
}

function appFor(
  state: ControlPlane,
  exchangeCode: () => Promise<SlackOAuthExchange> = async () => exchange,
  revokeBotToken = vi.fn(async () => undefined),
) {
  return {
    app: createLocalApp({
      plane: state,
      authMode: "disabled",
      slackAppCredentials: credentials,
      slackOAuthClient: { exchangeCode, revokeBotToken },
    }),
    revokeBotToken,
  };
}

async function start(
  app: ReturnType<typeof createLocalApp>["handler"],
  input: Record<string, unknown> = {},
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

function failedCallbackAudits(plane: ControlPlane) {
  return [...plane.state.auditLogs.values()].filter(
    (record) => record.action === "integration:slack:oauth:callback" && record.outcome === "failed",
  );
}

describe("Slack OAuth callback bot-token cleanup", () => {
  it("revokes each exchanged token whose installation is rejected", async () => {
    const cases: RejectedInstallationCase[] = [
      {
        name: "exchange validation",
        create: async () => ({
          plane: newPlane(encryptor),
          exchangeCode: async () => ({ ...exchange, scopes: ["chat:write"] }),
        }),
      },
      {
        name: "unavailable encryption",
        create: async () => ({ plane: newPlane() }),
      },
      {
        name: "encryption failure",
        create: async () => ({
          plane: newPlane({ ...encryptor, encrypt: async () => Promise.reject(new Error("KMS")) }),
        }),
      },
      {
        name: "workspace identity mismatch",
        expectedRevocation: false,
        create: async () => {
          const activePlane = newPlane(encryptor);
          await install(activePlane, { ...exchange, workspaceId: "T999" });
          const expectedInstallationId = activePlane.state.slackIntegration?.installationId;
          return { plane: activePlane, startInput: { expectedVersion: 1, expectedInstallationId } };
        },
      },
      {
        name: "version compare-and-swap",
        expectedRevocation: false,
        create: async () => ({
          plane: newPlane(encryptor),
          afterStart: async (state) => {
            await state.createSlackIntegrationDurable({
              botToken: token,
              defaultChannel: "#harness",
            });
          },
        }),
      },
      {
        name: "installation identity compare-and-swap",
        expectedRevocation: false,
        create: async () => {
          const activePlane = newPlane(encryptor);
          await install(activePlane, exchange);
          const staleInstallationId = activePlane.state.slackIntegration?.installationId;
          return {
            plane: activePlane,
            startInput: { expectedVersion: 1, expectedInstallationId: staleInstallationId },
            afterStart: async (state) => {
              await state.deleteSlackIntegrationDurable();
              await state.createSlackIntegrationDurable({
                botToken: token,
                defaultChannel: "#harness",
              });
            },
          };
        },
      },
    ];

    for (const testCase of cases) {
      const configured = await testCase.create();
      const { app, revokeBotToken } = appFor(configured.plane, configured.exchangeCode);
      const state = await start(app.handler, configured.startInput);
      await configured.afterStart?.(configured.plane);

      await expect(callback(app.handler, state)).resolves.toMatchObject({ status: 302 });
      if (testCase.expectedRevocation === false)
        expect(revokeBotToken, testCase.name).not.toHaveBeenCalled();
      else expect(revokeBotToken, testCase.name).toHaveBeenCalledExactlyOnceWith(token);
      expect(failedCallbackAudits(configured.plane), testCase.name).toHaveLength(1);
    }
  });

  it("keeps the installation rejection when token revocation fails", async () => {
    const activePlane = newPlane(encryptor);
    const revokeBotToken = vi.fn(async () => Promise.reject(new Error("Slack unavailable")));
    const { app } = appFor(
      activePlane,
      async () => ({ ...exchange, scopes: ["chat:write"] }),
      revokeBotToken,
    );
    const state = await start(app.handler);

    await expect(callback(app.handler, state)).resolves.toMatchObject({ status: 302 });
    expect(revokeBotToken).toHaveBeenCalledExactlyOnceWith(token);
    expect(failedCallbackAudits(activePlane)).toHaveLength(1);
  });
});
