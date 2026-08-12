import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";

const token = "xoxb-1234567890-abcdefghij";

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (_plaintext, context) => `ciphertext-${context.integrationId}`,
    decrypt: async () => "unused",
  };
}

function input() {
  return { botToken: token, signingSecret: "a".repeat(32), defaultChannel: "C0123ABCDE" };
}

function storage() {
  let record: SlackIntegrationRecord | undefined;
  return {
    getSlackIntegration: async () => (record ? { ...record } : null),
    putSlackIntegration: async (next: SlackIntegrationRecord, expectedVersion: number | null) => {
      if (
        (expectedVersion === null && record) ||
        (expectedVersion !== null && record?.version !== expectedVersion)
      ) {
        return false;
      }
      record = { ...next };
      return true;
    },
    deleteSlackIntegration: async (expectedVersion: number) => {
      if (!record || record.version !== expectedVersion) return false;
      record = undefined;
      return true;
    },
    snapshot: () => record && { ...record },
  };
}

describe("Slack integration configuration", () => {
  it("stores ciphertext only, redacts reads, and survives a restarted worker", async () => {
    const durable = storage();
    const writer = new ControlPlane({
      storage: durable as never,
      secretEncryptor: encryptor(),
      now: () => "2026-08-10T00:00:00.000Z",
    });
    const created = await writer.createSlackIntegrationDurable(input());
    expect(created).toMatchObject({ ok: true, integration: { botTokenConfigured: true } });
    expect(JSON.stringify(created)).not.toContain(token);
    expect(durable.snapshot()).toMatchObject({ encryptedConfig: "ciphertext-slack" });
    expect(JSON.stringify(durable.snapshot())).not.toContain(token);

    const restarted = new ControlPlane({ storage: durable as never, secretEncryptor: encryptor() });
    expect(await restarted.getSlackIntegrationDurable()).toMatchObject({
      defaultChannel: "C0123ABCDE",
      botTokenConfigured: true,
      signingSecretConfigured: true,
    });
  });

  it("uses compare-and-swap across workers and supports update/delete", async () => {
    const durable = storage();
    const first = new ControlPlane({ storage: durable as never, secretEncryptor: encryptor() });
    const second = new ControlPlane({ storage: durable as never, secretEncryptor: encryptor() });
    const [one, two] = await Promise.all([
      first.createSlackIntegrationDurable(input()),
      second.createSlackIntegrationDurable(input()),
    ]);
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
    expect(
      await first.updateSlackIntegrationDurable({
        ...input(),
        enabled: false,
        signingSecret: undefined,
      }),
    ).toMatchObject({ ok: true, integration: { enabled: false, signingSecretConfigured: false } });
    expect(await second.deleteSlackIntegrationDurable()).toEqual({ ok: true });
    expect(await first.getSlackIntegrationDurable()).toBeNull();
  });

  it("fails closed without encryption and rejects invalid secret-bearing inputs", async () => {
    const plain = new ControlPlane();
    await expect(plain.createSlackIntegrationDurable(input())).resolves.toMatchObject({
      ok: false,
      unavailable: true,
    });
    const protectedPlane = new ControlPlane({ secretEncryptor: encryptor() });
    for (const bad of [
      { ...input(), botToken: "xoxp-not-a-bot" },
      { ...input(), defaultChannel: "https://hooks.slack.com/not-a-channel" },
      { ...input(), signingSecret: "not-hex" },
      { ...input(), enabled: "yes" },
      { ...input(), notifications: { onSessionCreated: true } },
    ]) {
      await expect(
        protectedPlane.createSlackIntegrationDurable(bad as never),
      ).resolves.toMatchObject({
        ok: false,
      });
    }
  });

  it("reports missing records and rejected stale writes without leaking plaintext", async () => {
    const durable = storage();
    const plane = new ControlPlane({ storage: durable as never, secretEncryptor: encryptor() });
    expect(await plane.updateSlackIntegrationDurable(input())).toMatchObject({ ok: false });
    expect(await plane.deleteSlackIntegrationDurable()).toMatchObject({ ok: false });
    await plane.createSlackIntegrationDurable({ ...input(), defaultChannel: "#harness" });
    durable.putSlackIntegration = async () => false;
    expect(await plane.updateSlackIntegrationDurable(input())).toMatchObject({
      ok: false,
      conflict: true,
    });
    durable.deleteSlackIntegration = async () => false;
    expect(await plane.deleteSlackIntegrationDurable()).toMatchObject({
      ok: false,
      conflict: true,
    });
  });
});
