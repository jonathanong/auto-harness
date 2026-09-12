import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  decryptCustomWebhookSecret,
  validateConfiguredTargetReferences,
} from "./control-plane-custom-webhooks.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";

const secret = "s".repeat(32);

function encryptor(overrides: Partial<SecretEncryptor> = {}): SecretEncryptor {
  return {
    encrypt: async (value) => `cipher:${Buffer.from(value).toString("base64")}`,
    decrypt: async (value) => Buffer.from(value.slice("cipher:".length), "base64").toString("utf8"),
    ...overrides,
  };
}

function plane(secretEncryptor: SecretEncryptor | undefined = encryptor()): ControlPlane {
  const value = new ControlPlane({ secretEncryptor });
  value.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
  value.createProvider({ id: "provider", name: "provider", defaultCommandId: "command" });
  value.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: "provider" });
  return value;
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: "deploy",
    secret,
    repositoryId: "repo",
    target: { providerId: "provider" },
    timeout: 60,
    ...overrides,
  } as never;
}

describe("custom webhook integration lifecycle", () => {
  it("validates operator routing and KMS availability", async () => {
    const unavailablePlane = plane();
    unavailablePlane.state.secretEncryptor = undefined;
    const unavailable = await unavailablePlane.createCustomWebhookIntegration(config());
    expect(unavailable).toMatchObject({ ok: false, unavailable: true });
    const value = plane();
    for (const invalid of [
      { id: "bad id" },
      { secret: "short" },
      { repositoryId: "" },
      { target: { providerId: "" } },
      { timeout: 0 },
      { priority: 1.5 },
      { fallbacks: [{ providerId: "provider" }] },
      { requiredLabels: ["ok", 1] },
      { requiredLabels: Array.from({ length: 17 }, () => "label") },
      { requiredLabels: ["x".repeat(65)] },
      { enabled: "yes" },
    ]) {
      expect((await value.createCustomWebhookIntegration(config(invalid))).ok).toBe(false);
    }
    await expect(
      value.updateCustomWebhookIntegration(config({ secret: "short" })),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("secret") });
  });

  it("redacts secrets, retains them on routing updates, rotates explicitly, and deletes", async () => {
    const value = plane();
    const created = await value.createCustomWebhookIntegration(
      config({ priority: 4, enabled: false }),
    );
    expect(created).toMatchObject({
      ok: true,
      integration: { id: "deploy", secretConfigured: true, priority: 4, enabled: false },
    });
    expect(JSON.stringify(created)).not.toContain("cipher:");
    const before = await value.getCustomWebhookIntegrationRecord("deploy");
    const retained = await value.updateCustomWebhookIntegration(
      config({ secret: undefined, timeout: 120 }),
    );
    const afterRetain = await value.getCustomWebhookIntegrationRecord("deploy");
    expect(retained).toMatchObject({ ok: true, integration: { timeout: 120, version: 2 } });
    expect(afterRetain?.encryptedSecret).toBe(before?.encryptedSecret);
    const rotated = await value.updateCustomWebhookIntegration(config({ secret: "r".repeat(32) }));
    const afterRotate = await value.getCustomWebhookIntegrationRecord("deploy");
    expect(rotated).toMatchObject({ ok: true, integration: { version: 3 } });
    expect(afterRotate?.encryptedSecret).not.toBe(afterRetain?.encryptedSecret);
    expect(await value.deleteCustomWebhookIntegration("deploy")).toEqual({ ok: true });
    expect(await value.getCustomWebhookIntegration("deploy")).toBeNull();
    expect(await value.deleteCustomWebhookIntegration("deploy")).toMatchObject({ ok: false });
  });

  it("reports compare-and-swap conflicts and malformed ciphertext", async () => {
    const storage = {
      getRepository: async () => ({ id: "repo" }),
      listProviders: async () => [{ id: "provider" }],
      listCommands: async () => [{ id: "command" }],
      getCustomWebhookIntegration: async () => null,
      putCustomWebhookIntegration: async () => false,
    };
    const conflict = new ControlPlane({ secretEncryptor: encryptor(), storage: storage as never });
    expect(await conflict.createCustomWebhookIntegration(config())).toMatchObject({
      ok: false,
      conflict: true,
    });
    const malformed = plane(encryptor({ decrypt: async () => "not-json" }));
    const created = await malformed.createCustomWebhookIntegration(config());
    const record = await malformed.getCustomWebhookIntegrationRecord("deploy");
    await expect(decryptCustomWebhookSecret(malformed.state, "deploy", record!)).rejects.toThrow(
      "invalid",
    );
    expect(created.ok).toBe(true);
  });

  it("uses durable reads and writes, including compare-and-swap delete and update failures", async () => {
    let stored: Awaited<ReturnType<ControlPlane["getCustomWebhookIntegrationRecord"]>> = null;
    let writeAllowed = true;
    const storage = {
      getRepository: async () => ({ id: "repo" }),
      listProviders: async () => [{ id: "provider" }],
      listCommands: async () => [{ id: "command" }],
      getCustomWebhookIntegration: async () => stored,
      putCustomWebhookIntegration: async (record: NonNullable<typeof stored>) => {
        if (writeAllowed) stored = record;
        return writeAllowed;
      },
      deleteCustomWebhookIntegration: async () => {
        if (writeAllowed) stored = null;
        return writeAllowed;
      },
    };
    const value = new ControlPlane({ secretEncryptor: encryptor(), storage: storage as never });

    expect(await value.getCustomWebhookIntegration("deploy")).toBeNull();
    expect(await value.createCustomWebhookIntegration(config())).toMatchObject({ ok: true });
    expect(await value.getCustomWebhookIntegration("deploy")).toMatchObject({ id: "deploy" });

    writeAllowed = false;
    expect(await value.updateCustomWebhookIntegration(config())).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(await value.deleteCustomWebhookIntegration("deploy")).toMatchObject({
      ok: false,
      conflict: true,
    });

    writeAllowed = true;
    expect(await value.updateCustomWebhookIntegration(config({ secret: undefined }))).toMatchObject(
      {
        ok: true,
        integration: { version: 2 },
      },
    );
    expect(await value.deleteCustomWebhookIntegration("deploy")).toEqual({ ok: true });
  });

  it("rejects absent catalog references and every malformed encrypted-secret shape", async () => {
    const value = plane();
    await expect(
      validateConfiguredTargetReferences(value.state, "missing", { providerId: "provider" }),
    ).resolves.toMatchObject({ ok: false, error: "repository not found" });
    await expect(
      validateConfiguredTargetReferences(value.state, "repo", { providerId: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: "providerId missing not found" });
    await expect(
      validateConfiguredTargetReferences(value.state, "repo", { commandId: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: "commandId missing not found" });

    const created = await value.createCustomWebhookIntegration(config());
    expect(created.ok).toBe(true);
    const record = await value.getCustomWebhookIntegrationRecord("deploy");
    expect(record).not.toBeNull();
    value.state.secretEncryptor = undefined;
    await expect(decryptCustomWebhookSecret(value.state, "deploy", record!)).rejects.toThrow(
      "unavailable",
    );
    value.state.secretEncryptor = encryptor({ decrypt: async () => "{}" });
    await expect(decryptCustomWebhookSecret(value.state, "deploy", record!)).rejects.toThrow(
      "invalid",
    );
    value.state.secretEncryptor = encryptor({ decrypt: async () => '{"secret": 1}' });
    await expect(decryptCustomWebhookSecret(value.state, "deploy", record!)).rejects.toThrow(
      "invalid",
    );
  });
});
