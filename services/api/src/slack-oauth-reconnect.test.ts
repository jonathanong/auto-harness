import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { startSlackOAuth } from "./slack-oauth.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import type { SlackOAuthStateRecord } from "./slack-oauth-types.ts";

const credentials = { clientId: "123.456", clientSecret: "secret", signingSecret: "a".repeat(32) };

describe("Slack OAuth reconnect state", () => {
  it("rejects a stale start after the bound installation was deleted", async () => {
    const plane = new ControlPlane({
      now: () => "2026-09-12T00:00:00.000Z",
      publicBaseUrl: "https://harness.example",
    });

    await expect(
      startSlackOAuth(plane.state, credentials, {
        principalId: "admin:stale",
        expectedVersion: 1,
        expectedInstallationId: "deleted-installation",
        defaultChannel: "#harness",
      }),
    ).rejects.toThrow("Slack integration changed concurrently; retry");
    expect(plane.state.slackOAuthStates).toHaveLength(0);
  });

  it("inherits disabled and custom notifications from a local integration", async () => {
    const notifications = {
      ...DEFAULT_SLACK_NOTIFICATIONS,
      onSessionCreated: false,
      onHostOffline: false,
    };
    const plane = new ControlPlane({
      secretEncryptor: { encrypt: async (value) => value, decrypt: async (value) => value },
      now: () => "2026-09-12T00:00:00.000Z",
    });
    await plane.installSlackOAuthIntegrationDurable({
      expectedVersion: null,
      defaultChannel: "#harness",
      enabled: false,
      notifications,
      exchange: {
        botToken: "xoxb-1234567890-abcdefghij",
        workspaceId: "T123",
        appId: "A123",
        scopes: ["chat:write", "app_mentions:read", "im:history"],
      },
    });

    await startSlackOAuth(plane.state, credentials, {
      principalId: "admin:root",
      expectedVersion: 1,
      expectedInstallationId: plane.state.slackIntegration?.installationId,
      defaultChannel: "#harness",
    });

    expect(plane.state.slackOAuthStates.values().next().value).toMatchObject({
      expectedVersion: 1,
      expectedInstallationId: plane.state.slackIntegration?.installationId,
      enabled: false,
      notifications,
    });
  });

  it("inherits reconnect settings from the durable integration snapshot", async () => {
    const current: SlackIntegrationRecord = {
      id: "slack",
      type: "slack",
      encryptedConfig: "ciphertext",
      defaultChannel: "#old-channel",
      enabled: false,
      notifications: {
        ...DEFAULT_SLACK_NOTIFICATIONS,
        onSessionStarted: false,
        onScheduleCompleted: true,
      },
      signingSecretConfigured: false,
      installationMethod: "oauth",
      installationId: "installation-1",
      version: 4,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T01:00:00.000Z",
    };
    let stored: SlackOAuthStateRecord | undefined;
    const plane = new ControlPlane({
      now: () => "2026-09-12T00:00:00.000Z",
      publicBaseUrl: "https://harness.example",
    });
    plane.state.storage = {
      getSlackIntegration: async () => current,
      putSlackOAuthState: async (record: SlackOAuthStateRecord) => {
        stored = record;
        return true;
      },
    } as never;

    await startSlackOAuth(plane.state, credentials, {
      principalId: "admin:durable-reconnect",
      expectedVersion: 4,
      expectedInstallationId: current.installationId,
      defaultChannel: "#new-channel",
    });

    expect(stored).toMatchObject({
      expectedVersion: 4,
      expectedInstallationId: "installation-1",
      defaultChannel: "#new-channel",
      enabled: false,
      notifications: current.notifications,
    });
  });
});
