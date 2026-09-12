import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";
import {
  signSlackBody,
  signSlackRaw,
  slackTestCredentials,
  slackTestEncryptor,
  slackTestNow,
} from "../test-helpers/slack-route-test-helpers.ts";

const botToken = "xoxb-1234567890-abcdefghij";
const signingSecret = "manual-signing-secret";

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    authorizations: [{ user_id: "Ubot" }],
    event_id: "Ev1",
    event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
    ...overrides,
  };
}

describe("Slack event metadata boundary", () => {
  it("persists a manual token's verified identity and fences accepted events to it", async () => {
    const authTestBotToken = vi.fn().mockResolvedValue({
      workspaceId: "T1",
      workspaceName: "Workspace",
      botUserId: "Ubot",
    });
    const plane = new ControlPlane({
      secretEncryptor: slackTestEncryptor,
      now: () => slackTestNow,
      slackOAuthClient: { authTestBotToken },
    });
    await expect(
      plane.createSlackIntegrationDurable({
        botToken,
        signingSecret,
        defaultChannel: "#harness",
      }),
    ).resolves.toMatchObject({
      ok: true,
      integration: { inboundAvailable: true, workspaceId: "T1", botUserId: "Ubot" },
    });
    expect(authTestBotToken).toHaveBeenCalledWith(botToken);

    const app = createLocalApp({ plane, authMode: "disabled" });
    const good = event();
    expect(
      await invokeHandler(
        app.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        good,
        signSlackRaw(JSON.stringify(good), signingSecret),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
    for (const rejected of [
      event({ team_id: "T2", event_id: "Ev2" }),
      event({ authorizations: [{ user_id: "Uother" }], event_id: "Ev3" }),
    ]) {
      expect(
        await invokeHandler(
          app.handler,
          "POST",
          "/api/v1/integrations/slack/events",
          rejected,
          signSlackRaw(JSON.stringify(rejected), signingSecret),
        ),
      ).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });
    }
  });

  it("keeps manual outbound configuration but disables inbound when identity cannot be verified", async () => {
    const plane = new ControlPlane({
      secretEncryptor: slackTestEncryptor,
      now: () => slackTestNow,
      slackOAuthClient: { authTestBotToken: async () => Promise.reject(new Error("unavailable")) },
    });
    await expect(
      plane.createSlackIntegrationDurable({ botToken, signingSecret, defaultChannel: "#harness" }),
    ).resolves.toMatchObject({
      ok: true,
      integration: {
        botTokenConfigured: true,
        signingSecretConfigured: true,
        inboundAvailable: false,
      },
    });
    const received = event();
    expect(
      await invokeHandler(
        createLocalApp({ plane, authMode: "disabled" }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        received,
        signSlackRaw(JSON.stringify(received), signingSecret),
      ),
    ).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });
  });

  it("uses the runtime OAuth signing secret without a KMS decrypt before rejecting invalid signatures", async () => {
    const decrypt = vi.fn(async () => {
      throw new Error("bot-token KMS decrypt must not run");
    });
    const plane = new ControlPlane({
      now: () => slackTestNow,
      secretEncryptor: { encrypt: async () => "ciphertext", decrypt },
    });
    plane.state.slackIntegration = {
      id: "slack",
      type: "slack",
      encryptedConfig: "ciphertext",
      defaultChannel: "#harness",
      enabled: true,
      notifications: {
        onSessionCreated: true,
        onSessionStarted: true,
        onSessionCompleted: true,
        onSessionFailed: true,
        onSessionCancelled: true,
        onSessionTimedOut: true,
        onHostOffline: true,
      },
      signingSecretConfigured: false,
      installationMethod: "oauth",
      workspaceId: "T1",
      appId: "A1",
      version: 1,
      createdAt: slackTestNow,
      updatedAt: slackTestNow,
    } satisfies SlackIntegrationRecord;

    const received = event();
    expect(
      await invokeHandler(
        createLocalApp({
          plane,
          authMode: "disabled",
          slackAppCredentials: slackTestCredentials,
        }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        received,
        signSlackBody({ ...received, event_id: "different" }),
      ),
    ).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });
    expect(decrypt).not.toHaveBeenCalled();
  });
});
