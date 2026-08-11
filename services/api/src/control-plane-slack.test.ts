import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";

const token = "xoxb-1234567890-abcdefghij";

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (_plaintext, context) => `ciphertext-${context.integrationId}`,
    decrypt: async (_ciphertext, _context) => "",
  };
}

function input() {
  return {
    botToken: token,
    signingSecret: "a".repeat(32),
    defaultChannel: "C0123ABCDE",
  };
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

describe("Slack integration durable configuration", () => {
  it("persists only ciphertext, redacts reads, and survives a fresh control plane", async () => {
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
      signingSecretConfigured: true,
      botTokenConfigured: true,
    });
    expect(JSON.stringify(await restarted.getSlackIntegrationDurable())).not.toContain(
      "encryptedConfig",
    );
  });

  it("uses conditional writes to reject concurrent creates and stale updates", async () => {
    const durable = storage();
    const first = new ControlPlane({ storage: durable as never, secretEncryptor: encryptor() });
    const second = new ControlPlane({ storage: durable as never, secretEncryptor: encryptor() });
    const [a, b] = await Promise.all([
      first.createSlackIntegrationDurable(input()),
      second.createSlackIntegrationDurable(input()),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);

    const current = durable.snapshot()!;
    expect(
      await durable.putSlackIntegration(
        { ...current, defaultChannel: "#updated", version: current.version + 1 },
        current.version,
      ),
    ).toBe(true);
    expect(await durable.deleteSlackIntegration(current.version)).toBe(false);
  });

  it("fails closed without a KMS encryptor and validates Slack identifiers", async () => {
    const plane = new ControlPlane();
    await expect(plane.createSlackIntegrationDurable(input())).resolves.toMatchObject({
      ok: false,
      error: "Slack secret encryption is not configured",
    });
    const protectedPlane = new ControlPlane({ secretEncryptor: encryptor() });
    await expect(
      protectedPlane.createSlackIntegrationDurable({
        ...input(),
        defaultChannel: "https://hooks.slack.com/x",
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("defaultChannel") });
    await expect(
      protectedPlane.createSlackIntegrationDurable({ ...input(), botToken: "xoxp-not-a-bot" }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("botToken") });
    await expect(
      protectedPlane.createSlackIntegrationDurable({ ...input(), signingSecret: "not-hex" }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("signingSecret") });
    await expect(
      protectedPlane.createSlackIntegrationDurable({
        ...input(),
        enabled: "yes",
      } as never),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("enabled") });
    await expect(
      protectedPlane.createSlackIntegrationDurable({
        ...input(),
        notifications: { onSessionCreated: true },
      } as never),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("notifications") });
  });

  it("supports memory-only CRUD and rejects durable write races", async () => {
    const memory = new ControlPlane({ secretEncryptor: encryptor() });
    expect(memory.getSlackIntegration()).toBeNull();
    expect(
      (await memory.createSlackIntegrationDurable({ ...input(), signingSecret: undefined })).ok,
    ).toBe(true);
    expect(
      await memory.updateSlackIntegrationDurable({ ...input(), enabled: false }),
    ).toMatchObject({
      ok: true,
      integration: { enabled: false, signingSecretConfigured: true },
    });
    expect(await memory.deleteSlackIntegrationDurable()).toEqual({ ok: true });
    expect(await memory.deleteSlackIntegrationDurable()).toMatchObject({ ok: false });
    expect(await memory.updateSlackIntegrationDurable(input())).toMatchObject({ ok: false });
    expect(await memory.getSlackIntegrationDurable()).toBeNull();
    await memory.createSlackIntegrationDurable(input());
    expect(await memory.createSlackIntegrationDurable(input())).toMatchObject({
      ok: false,
      conflict: true,
    });

    const durable = storage();
    const conflicting = new ControlPlane({
      storage: durable as never,
      secretEncryptor: encryptor(),
    });
    (durable.putSlackIntegration as unknown as () => Promise<boolean>) = async () => false;
    await expect(conflicting.createSlackIntegrationDurable(input())).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });

    const stable = storage();
    const durablePlane = new ControlPlane({
      storage: stable as never,
      secretEncryptor: encryptor(),
    });
    expect((await durablePlane.createSlackIntegrationDurable(input())).ok).toBe(true);
    expect(
      await durablePlane.updateSlackIntegrationDurable({
        ...input(),
        notifications: {
          onSessionCreated: false,
          onSessionStarted: false,
          onSessionCompleted: false,
          onSessionFailed: false,
          onSessionCancelled: false,
          onScheduleCompleted: true,
        },
      }),
    ).toMatchObject({ ok: true, integration: { version: 2 } });
    (stable.putSlackIntegration as unknown as () => Promise<boolean>) = async () => false;
    await expect(durablePlane.updateSlackIntegrationDurable(input())).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    (stable.deleteSlackIntegration as unknown as () => Promise<boolean>) = async () => false;
    await expect(durablePlane.deleteSlackIntegrationDurable()).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    (stable.deleteSlackIntegration as unknown as (version: number) => Promise<boolean>) =
      async () => true;
    await expect(durablePlane.deleteSlackIntegrationDurable()).resolves.toEqual({ ok: true });
  });
});
