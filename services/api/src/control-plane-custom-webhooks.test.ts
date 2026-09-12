import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { decryptCustomWebhookSecret } from "./control-plane-custom-webhooks.ts";
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
});
