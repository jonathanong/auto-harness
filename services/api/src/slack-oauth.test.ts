import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { consumeSlackOAuth, slackCallbackUrl, startSlackOAuth } from "./slack-oauth.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackOAuthStateRecord } from "./slack-oauth-types.ts";

const credentials = { clientId: "123.456", clientSecret: "secret", signingSecret: "a".repeat(32) };

describe("Slack OAuth state", () => {
  it("persists only a hash, binds settings/version/principal, and consumes once", async () => {
    const plane = new ControlPlane({
      now: () => "2026-09-12T00:00:00.000Z",
      publicBaseUrl: "https://harness.example",
    });
    const started = await startSlackOAuth(plane.state, credentials, {
      principalId: "admin:root",
      expectedVersion: 3,
      defaultChannel: "#harness",
    });
    const token = new URL(started.url).searchParams.get("state")!;
    expect(plane.state.slackOAuthStates.values().next().value).toMatchObject({
      principalId: "admin:root",
      publicBaseUrl: "https://harness.example",
      expectedVersion: 3,
      expectedInstallationId: null,
      defaultChannel: "#harness",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      expiresAt: 1789171800,
    });
    expect(plane.state.slackOAuthStates.values().next().value.stateHash).not.toContain(token);
    expect(await consumeSlackOAuth(plane.state, token)).toMatchObject({
      principalId: "admin:root",
    });
    expect(await consumeSlackOAuth(plane.state, token)).toBeNull();
    expect(slackCallbackUrl(plane.state.publicBaseUrl)).toBe(
      "https://harness.example/api/v1/integrations/slack/oauth/callback",
    );
  });

  it("uses the expected version fence for first install/reconnect and does not switch OAuth identity", async () => {
    const encryptor: SecretEncryptor = {
      encrypt: async (value) => value,
      decrypt: async (value) => value,
    };
    const plane = new ControlPlane({
      secretEncryptor: encryptor,
      now: () => "2026-09-12T00:00:00.000Z",
    });
    const exchange = {
      botToken: "xoxb-1234567890-abcdefghij",
      workspaceId: "T123",
      appId: "A123",
      scopes: ["chat:write", "app_mentions:read", "im:history"],
    };
    const input = {
      expectedVersion: null,
      defaultChannel: "#harness",
      enabled: true,
      notifications: {
        onSessionCreated: true,
        onSessionStarted: true,
        onSessionCompleted: true,
        onSessionFailed: true,
        onSessionCancelled: true,
        onScheduleCompleted: false,
        onHostOffline: true,
      },
      exchange,
    };
    expect((await plane.installSlackOAuthIntegrationDurable(input)).ok).toBe(true);
    expect(
      (await plane.installSlackOAuthIntegrationDurable({ ...input, expectedVersion: null })).ok,
    ).toBe(false);
    expect(
      (
        await plane.installSlackOAuthIntegrationDurable({
          ...input,
          expectedVersion: 1,
          exchange: { ...exchange, appId: "A999" },
        })
      ).ok,
    ).toBe(false);
    expect(
      (await plane.installSlackOAuthIntegrationDurable({ ...input, expectedVersion: 1 })).ok,
    ).toBe(true);
  });

  it("uses the durable state store and fails closed when it rejects a state", async () => {
    let stored: SlackOAuthStateRecord | undefined;
    const consumed: Array<{ hash: string; now: number }> = [];
    const plane = new ControlPlane({
      now: () => "2026-09-12T00:00:00.000Z",
    });
    plane.state.storage = {
      getSlackIntegration: async () => null,
      putSlackOAuthState: async (record: SlackOAuthStateRecord) => {
        stored = record;
        return true;
      },
      consumeSlackOAuthState: async (hash: string, now: number) => {
        consumed.push({ hash, now });
        return stored ?? null;
      },
    } as never;

    const started = await startSlackOAuth(plane.state, credentials, {
      principalId: "admin:durable",
      expectedVersion: null,
      defaultChannel: "C123456789",
      enabled: false,
      notifications: { onSessionCreated: false },
    });
    const token = new URL(started.url).searchParams.get("state")!;
    expect(stored).toMatchObject({ principalId: "admin:durable", enabled: false });
    expect(await consumeSlackOAuth(plane.state, token)).toBe(stored);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.hash).not.toContain(token);

    plane.state.storage.putSlackOAuthState = async () => false;
    await expect(
      startSlackOAuth(plane.state, credentials, {
        principalId: "admin:durable",
        expectedVersion: null,
        defaultChannel: "#harness",
      }),
    ).rejects.toThrow("unable to create Slack OAuth state");
  });

  it("rejects malformed and expired callback state tokens", async () => {
    let now = "2026-09-12T00:00:00.000Z";
    const plane = new ControlPlane({ now: () => now });
    expect(await consumeSlackOAuth(plane.state, "short")).toBeNull();
    expect(await consumeSlackOAuth(plane.state, "a".repeat(129))).toBeNull();

    const started = await startSlackOAuth(plane.state, credentials, {
      principalId: "admin:expired",
      expectedVersion: null,
      defaultChannel: "#harness",
    });
    const token = new URL(started.url).searchParams.get("state")!;
    const expiresAt = plane.state.slackOAuthStates.values().next().value.expiresAt as number;
    now = new Date(expiresAt * 1000).toISOString();
    expect(await consumeSlackOAuth(plane.state, token)).toBeNull();
    expect(plane.state.slackOAuthStates.size).toBe(0);
  });

  it("fails closed if a locally generated state hash already exists", async () => {
    const plane = new ControlPlane({ now: () => "2026-09-12T00:00:00.000Z" });
    class CollisionMap extends Map<string, SlackOAuthStateRecord> {
      override has(key: string): boolean {
        expect(key).toMatch(/^[a-f0-9]{64}$/);
        return true;
      }
    }
    plane.state.slackOAuthStates = new CollisionMap();
    await expect(
      startSlackOAuth(plane.state, credentials, {
        principalId: "admin:collision",
        expectedVersion: null,
        defaultChannel: "#harness",
      }),
    ).rejects.toThrow("unable to create Slack OAuth state");
  });
});
