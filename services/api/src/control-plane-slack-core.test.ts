import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { publicIntegration } from "./control-plane-slack.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import { slackTestOAuthClient } from "../test-helpers/slack-route-test-helpers.ts";

const token = "xoxb-1234567890-abcdefghij";
const signingSecret = "manual-slack-signing-secret-12345";

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (value) => Buffer.from(value).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString(),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return { botToken: token, defaultChannel: "#harness", ...overrides };
}

describe("Slack control-plane durability", () => {
  it("returns null snapshots and evaluates manual and OAuth inbound availability", async () => {
    const plane = new ControlPlane({
      secretEncryptor: encryptor(),
      slackOAuthClient: slackTestOAuthClient,
    });
    expect(await plane.getSlackIntegration()).toBeNull();
    expect(await plane.getSlackIntegrationDurable()).toBeNull();
    await plane.createSlackIntegrationDurable(input({ signingSecret }));
    expect(await plane.getSlackIntegration()).toMatchObject({ inboundAvailable: true });
    await plane.updateSlackIntegrationDurable(input());
    expect(await plane.getSlackIntegration()).toMatchObject({ inboundAvailable: false });
    plane.state.slackIntegration = {
      ...plane.state.slackIntegration!,
      installationMethod: "oauth",
      workspaceId: "T123",
      appId: "A123",
    };
    expect(await plane.getSlackIntegration()).toMatchObject({ inboundAvailable: false });
    plane.state.slackInboundEnabled = true;
    expect(await plane.getSlackIntegration()).toMatchObject({ inboundAvailable: true });
  });

  it("merges partial patches without replacing credentials and handles local deletion", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor(), now: () => "first" });
    expect(
      await plane.patchSlackIntegrationDurable({ expectedVersion: 1, enabled: false }),
    ).toMatchObject({
      ok: false,
    });
    await plane.createSlackIntegrationDurable(input({ signingSecret }));
    const originalCiphertext = plane.state.slackIntegration!.encryptedConfig;
    const notifications = await plane.patchSlackIntegrationDurable({
      expectedVersion: 1,
      notifications: { onHostOffline: false },
    });
    expect(notifications).toMatchObject({
      ok: true,
      integration: { notifications: { onHostOffline: false, onSessionCreated: true } },
    });
    plane.state.now = () => "second";
    const settings = await plane.patchSlackIntegrationDurable({
      expectedVersion: 2,
      defaultChannel: "C0123ABCDE",
      enabled: false,
    });
    expect(settings).toMatchObject({
      ok: true,
      integration: { defaultChannel: "C0123ABCDE", enabled: false, updatedAt: "second" },
    });
    expect(plane.state.slackIntegration!.encryptedConfig).toBe(originalCiphertext);
    expect(
      await plane.patchSlackIntegrationDurable({ expectedVersion: 1, enabled: true }),
    ).toMatchObject({ ok: false, conflict: true });
    expect(plane.state.slackIntegration).toMatchObject({ version: 3, enabled: false });
    expect(await plane.deleteSlackIntegrationDurable()).toEqual({ ok: true });
    expect(await plane.deleteSlackIntegrationDurable()).toMatchObject({ ok: false });
  });

  it("refreshes the cache after rejected create, update, patch, and delete compares", async () => {
    const stored = await record();
    const storage = staleStorage(stored);
    const plane = new ControlPlane({ storage: storage as never, secretEncryptor: encryptor() });

    expect(await plane.createSlackIntegrationDurable(input())).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(plane.state.slackIntegration).toMatchObject({ version: 7 });
    storage.current = undefined;
    expect(await plane.updateSlackIntegrationDurable(input())).toMatchObject({ ok: false });
    storage.current = stored;
    expect(await plane.updateSlackIntegrationDurable(input())).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(
      await plane.patchSlackIntegrationDurable({ expectedVersion: 7, enabled: false }),
    ).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(await plane.deleteSlackIntegrationDurable()).toMatchObject({
      ok: false,
      conflict: true,
    });
  });

  it("rejects invalid patches and persists accepted durable settings without leaking secrets", async () => {
    const stored = await record();
    let writes = 0;
    const storage = {
      getSlackIntegration: async () => ({ ...stored }),
      putSlackIntegration: async () => ++writes === 1,
    };
    const plane = new ControlPlane({ storage: storage as never, secretEncryptor: encryptor() });
    expect(await plane.patchSlackIntegrationDurable({ expectedVersion: 7 })).toMatchObject({
      ok: false,
    });
    await expect(
      plane.patchSlackIntegrationDurable({ expectedVersion: 7, enabled: false }),
    ).resolves.toMatchObject({
      ok: true,
      integration: { enabled: false, botTokenConfigured: true },
    });
    const legacyManual = { ...stored };
    delete legacyManual.installationMethod;
    expect(await publicIntegration(plane.state, legacyManual)).toMatchObject({
      installationMethod: "manual",
      inboundAvailable: false,
    });
    expect(
      await publicIntegration(plane.state, { ...stored, installationMethod: "oauth" }),
    ).toMatchObject({
      inboundAvailable: false,
    });
    plane.state.slackInboundEnabled = true;
    expect(
      await publicIntegration(plane.state, { ...stored, installationMethod: "oauth" }),
    ).toMatchObject({
      inboundAvailable: true,
    });
  });
});

async function record(): Promise<SlackIntegrationRecord> {
  const plane = new ControlPlane({ secretEncryptor: encryptor() });
  await plane.createSlackIntegrationDurable(input());
  return { ...plane.state.slackIntegration!, version: 7 };
}

function staleStorage(current: SlackIntegrationRecord | undefined) {
  let firstRead = true;
  return {
    current,
    getSlackIntegration: async function (this: { current?: SlackIntegrationRecord }) {
      if (firstRead) {
        firstRead = false;
        return null;
      }
      return this.current ? { ...this.current } : null;
    },
    putSlackIntegration: async () => false,
    deleteSlackIntegration: async () => false,
  };
}
