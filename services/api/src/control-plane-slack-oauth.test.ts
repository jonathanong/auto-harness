import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";

const token = "xoxb-1234567890-abcdefghij";

function encryptor(): SecretEncryptor {
  return { encrypt: async (value) => value, decrypt: async (value) => value };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: null,
    defaultChannel: "#harness",
    enabled: true,
    notifications: DEFAULT_SLACK_NOTIFICATIONS,
    exchange: {
      botToken: token,
      workspaceId: "T123",
      appId: "A123",
      scopes: ["chat:write", "app_mentions:read", "im:history"],
    },
    ...overrides,
  };
}

describe("Slack OAuth installation", () => {
  it("fails closed for invalid exchanges and unavailable encryption", async () => {
    const encrypted = new ControlPlane({ secretEncryptor: encryptor() });
    for (const exchange of [
      { ...input().exchange, botToken: "xoxp-user" },
      { ...input().exchange, workspaceId: "team" },
      { ...input().exchange, appId: "app" },
      { ...input().exchange, scopes: ["chat:write"] },
    ]) {
      await expect(
        encrypted.installSlackOAuthIntegrationDurable(input({ exchange }) as never),
      ).resolves.toMatchObject({ ok: false, error: "Slack OAuth response was invalid" });
    }
    await expect(
      new ControlPlane().installSlackOAuthIntegrationDurable(input() as never),
    ).resolves.toMatchObject({ ok: false, unavailable: true });
  });

  it("stores optional identity metadata and preserves created time on same-workspace reconnect", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor(), now: () => "first" });
    const first = await plane.installSlackOAuthIntegrationDurable(
      input({
        exchange: { ...input().exchange, workspaceName: "Harness", botUserId: "U123" },
      }) as never,
    );
    expect(first).toMatchObject({
      ok: true,
      integration: { workspaceName: "Harness", botUserId: "U123", signingSecretConfigured: false },
    });
    if (!first.ok) throw new Error("OAuth install failed");
    expect(first.integration.installationId).toEqual(expect.any(String));
    plane.state.now = () => "second";
    const reconnect = await plane.installSlackOAuthIntegrationDurable(
      input({ expectedVersion: 1 }) as never,
    );
    expect(reconnect).toMatchObject({
      ok: true,
      integration: { version: 2, createdAt: "first", updatedAt: "second" },
    });
    expect(plane.state.slackIntegration).not.toHaveProperty("workspaceName");
    expect(plane.state.slackIntegration).not.toHaveProperty("botUserId");
  });

  it("fences stale versions, identity changes, and failed durable compares", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    await plane.installSlackOAuthIntegrationDurable(input() as never);
    await expect(
      plane.installSlackOAuthIntegrationDurable(input({ expectedVersion: null }) as never),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    await expect(
      plane.installSlackOAuthIntegrationDurable(
        input({
          expectedVersion: 1,
          exchange: { ...input().exchange, workspaceId: "T999" },
        }) as never,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Slack OAuth installation does not match"),
    });

    const storage = oauthStorage(false);
    const durable = new ControlPlane({ storage: storage as never, secretEncryptor: encryptor() });
    await expect(
      durable.installSlackOAuthIntegrationDurable(input() as never),
    ).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    await expect(
      durable.installSlackOAuthIntegrationDurable(
        input({ expectedInstallationId: "installation-that-was-deleted" }) as never,
      ),
    ).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });

    const accepted = oauthStorage(true);
    const stored = new ControlPlane({ storage: accepted as never, secretEncryptor: encryptor() });
    await expect(
      stored.installSlackOAuthIntegrationDurable(input() as never),
    ).resolves.toMatchObject({
      ok: true,
      integration: { installationMethod: "oauth", version: 1 },
    });
  });

  it("rejects a reconnect from a deleted installation after version reset", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    await expect(
      plane.installSlackOAuthIntegrationDurable(input() as never),
    ).resolves.toMatchObject({
      ok: true,
    });
    const previousInstallationId = plane.state.slackIntegration?.installationId;
    expect(previousInstallationId).toEqual(expect.any(String));

    await expect(plane.deleteSlackIntegrationDurable()).resolves.toEqual({ ok: true });
    await expect(
      plane.createSlackIntegrationDurable({
        botToken: token,
        defaultChannel: "#harness",
      }),
    ).resolves.toMatchObject({ ok: true, integration: { version: 1 } });
    expect(plane.state.slackIntegration?.installationId).not.toBe(previousInstallationId);

    await expect(
      plane.installSlackOAuthIntegrationDurable(
        input({ expectedVersion: 1, expectedInstallationId: previousInstallationId }) as never,
      ),
    ).resolves.toMatchObject({ ok: false, conflict: true });
  });
});

function oauthStorage(putResult: boolean) {
  let record: SlackIntegrationRecord | undefined;
  return {
    getSlackIntegration: async () => record ?? null,
    putSlackIntegration: async (next: SlackIntegrationRecord) => {
      if (putResult) record = next;
      return putResult;
    },
  };
}
