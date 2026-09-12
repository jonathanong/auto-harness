/* eslint-disable max-lines -- lifecycle branch coverage shares focused fixtures. */
import { describe, expect, it, vi } from "vitest";

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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
      { requiredLabels: [""] },
      { requiredLabels: Array.from({ length: 17 }, () => "label") },
      { requiredLabels: ["x".repeat(65)] },
      { enabled: "yes" },
    ]) {
      expect((await value.createCustomWebhookIntegration(config(invalid))).ok).toBe(false);
    }
    await expect(value.createCustomWebhookIntegration(config())).resolves.toMatchObject({
      ok: true,
    });
    const createdRecord = await value.getCustomWebhookIntegrationRecord("deploy");
    await expect(value.decryptCustomWebhookSecret("deploy", createdRecord!)).resolves.toBe(secret);
    await expect(
      value.updateCustomWebhookIntegration(config({ secret: "short" })),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("secret") });
    await expect(
      value.updateCustomWebhookIntegration(config({ secret: 123 as never })),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("secret") });
    await expect(
      value.updateCustomWebhookIntegration(config({ secret: "😀".repeat(8) })),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("secret") });
    await expect(
      value.updateCustomWebhookIntegration(config({ secret: "😀".repeat(16) })),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      value.updateCustomWebhookIntegration(config({ requiredLabels: ["😀".repeat(17)] })),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("requiredLabels") });
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
    expect(afterRetain?.generation).toBe(before?.generation);
    await expect(
      value.updateCustomWebhookIntegration(config({ secret: undefined }), 1),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    const rotated = await value.updateCustomWebhookIntegration(config({ secret: "r".repeat(32) }));
    const afterRotate = await value.getCustomWebhookIntegrationRecord("deploy");
    expect(rotated).toMatchObject({ ok: true, integration: { version: 3 } });
    expect(afterRotate?.encryptedSecret).not.toBe(afterRetain?.encryptedSecret);
    await expect(value.deleteCustomWebhookIntegration("deploy", 2)).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
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

  it("serializes concurrent in-memory creates before asynchronous encryption", async () => {
    const encryptionStarted = deferred<void>();
    const releaseEncryption = deferred<void>();
    const value = plane(
      encryptor({
        encrypt: vi.fn(async (plaintext) => {
          encryptionStarted.resolve();
          await releaseEncryption.promise;
          return `cipher:${Buffer.from(plaintext).toString("base64")}`;
        }),
      }),
    );
    const first = value.createCustomWebhookIntegration(config({ secret: "a".repeat(32) }));
    await encryptionStarted.promise;
    const second = value.createCustomWebhookIntegration(config({ secret: "b".repeat(32) }));
    await Promise.resolve();
    expect(value.state.customWebhookIntegrations.size).toBe(0);
    releaseEncryption.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: false, conflict: true });
  });

  it("serializes concurrent in-memory updates before asynchronous encryption", async () => {
    const value = plane();
    await expect(value.createCustomWebhookIntegration(config())).resolves.toMatchObject({
      ok: true,
    });
    const encryptionStarted = deferred<void>();
    const releaseEncryption = deferred<void>();
    value.state.secretEncryptor = encryptor({
      encrypt: vi.fn(async (plaintext) => {
        encryptionStarted.resolve();
        await releaseEncryption.promise;
        return `cipher:${Buffer.from(plaintext).toString("base64")}`;
      }),
    });
    const first = value.updateCustomWebhookIntegration(config({ secret: "a".repeat(32) }), 1);
    await encryptionStarted.promise;
    const second = value.updateCustomWebhookIntegration(config({ secret: "b".repeat(32) }), 1);
    await Promise.resolve();
    expect((await value.getCustomWebhookIntegration("deploy"))?.version).toBe(1);
    releaseEncryption.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: false, conflict: true });
  });

  it("validates both provider and command fallback references", async () => {
    const value = plane();
    await expect(
      value.createCustomWebhookIntegration(
        config({ target: { commandId: "command" }, fallbacks: [{ providerId: "provider" }] }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      value.createCustomWebhookIntegration(
        config({ id: "missing-fallback", fallbacks: [{ commandId: "missing" }] }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "commandId missing not found" });
  });

  it("persists normalized routing references", async () => {
    const value = plane();
    const created = await value.createCustomWebhookIntegration(
      config({
        target: { providerId: "provider", unexpected: "discarded" },
        fallbacks: [{ commandId: "command", unexpected: "discarded" }],
        queueTtlSeconds: undefined,
      }),
    );
    expect(created).toMatchObject({
      ok: true,
      integration: {
        target: { providerId: "provider" },
        fallbacks: [{ commandId: "command" }],
        queueTtlSeconds: 691_200,
      },
    });
    expect(await value.getCustomWebhookIntegration("deploy")).toMatchObject({
      target: { providerId: "provider" },
      fallbacks: [{ commandId: "command" }],
      queueTtlSeconds: 691_200,
    });
  });

  it("accepts an explicitly empty fallback list", async () => {
    await expect(
      plane().createCustomWebhookIntegration(config({ fallbacks: [] })),
    ).resolves.toMatchObject({ ok: true });
  });

  it("fences observed generations across delete and recreate", async () => {
    const value = plane();
    const first = await value.createCustomWebhookIntegration(config());
    if (!first.ok) throw new Error("expected integration");
    const oldGeneration = first.integration.generation;
    await expect(value.deleteCustomWebhookIntegration("deploy", 1, oldGeneration)).resolves.toEqual(
      {
        ok: true,
      },
    );
    const recreated = await value.createCustomWebhookIntegration(config());
    if (!recreated.ok) throw new Error("expected recreated integration");
    expect(recreated.integration.generation).not.toBe(oldGeneration);
    await expect(
      value.updateCustomWebhookIntegration(config({ timeout: 90 }), 1, oldGeneration),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    await expect(
      value.deleteCustomWebhookIntegration("deploy", 1, oldGeneration),
    ).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
  });

  it("accepts legacy delete fences and rejects them for generated records", async () => {
    const value = plane();
    await value.createCustomWebhookIntegration(config());
    const legacy = await value.getCustomWebhookIntegrationRecord("deploy");
    expect(legacy).not.toBeNull();
    delete legacy!.generation;
    await expect(value.deleteCustomWebhookIntegration("deploy", 1, null)).resolves.toEqual({
      ok: true,
    });

    await value.createCustomWebhookIntegration(config());
    await expect(value.deleteCustomWebhookIntegration("deploy", 1, null)).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    await expect(
      value.updateCustomWebhookIntegration(config({ timeout: 90 }), 1, null),
    ).resolves.toMatchObject({ ok: false, conflict: true });
  });

  it("uses the durable integration record for reads and rejects lifecycle writes with missing references", async () => {
    const source = plane();
    await expect(source.createCustomWebhookIntegration(config())).resolves.toMatchObject({
      ok: true,
    });
    const stored = await source.getCustomWebhookIntegrationRecord("deploy");
    expect(stored).not.toBeNull();
    const durable = new ControlPlane({
      secretEncryptor: encryptor(),
      storage: { getCustomWebhookIntegration: async () => stored } as never,
    });
    await expect(durable.getCustomWebhookIntegration("deploy")).resolves.toMatchObject({
      id: "deploy",
      secretConfigured: true,
    });
    await expect(durable.getCustomWebhookIntegrationRecord("deploy")).resolves.toEqual(stored);

    const value = plane();
    await expect(
      value.createCustomWebhookIntegration(config({ repositoryId: "missing" })),
    ).resolves.toMatchObject({ ok: false, error: "repository not found" });
    await expect(
      value.updateCustomWebhookIntegration(config({ target: { providerId: "missing" } })),
    ).resolves.toMatchObject({ ok: false, error: "providerId missing not found" });
    value.state.secretEncryptor = undefined;
    await expect(value.updateCustomWebhookIntegration(config())).resolves.toMatchObject({
      ok: false,
      unavailable: true,
    });
  });

  it("fences durable updates and deletes when their compare-and-swap writes lose", async () => {
    const source = plane();
    await source.createCustomWebhookIntegration(config());
    const stored = await source.getCustomWebhookIntegrationRecord("deploy");
    expect(stored).not.toBeNull();
    const storage = {
      getRepository: async () => ({ id: "repo" }),
      listProviders: async () => [{ id: "provider" }],
      listCommands: async () => [{ id: "command" }],
      getCustomWebhookIntegration: async () => stored,
      putCustomWebhookIntegration: async () => false,
      deleteCustomWebhookIntegration: async () => false,
      acquireDeletionMarker: async () => true,
      releaseDeletionMarker: async () => undefined,
    };
    const durable = new ControlPlane({ secretEncryptor: encryptor(), storage: storage as never });
    await expect(
      durable.updateCustomWebhookIntegration(config({ secret: undefined })),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    await expect(durable.deleteCustomWebhookIntegration("deploy")).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
  });

  it("passes a null generation fence for legacy durable records", async () => {
    const source = plane();
    await source.createCustomWebhookIntegration(config());
    const stored = await source.getCustomWebhookIntegrationRecord("deploy");
    expect(stored).not.toBeNull();
    delete stored!.generation;
    let putGeneration: string | null | undefined;
    let deleteGeneration: string | null | undefined;
    const storage = {
      getRepository: async () => ({ id: "repo" }),
      listProviders: async () => [{ id: "provider" }],
      listCommands: async () => [{ id: "command" }],
      getCustomWebhookIntegration: async () => stored,
      putCustomWebhookIntegration: async (
        _record: unknown,
        _version: number | null,
        _markers: unknown,
        generation: string | null,
      ) => {
        putGeneration = generation;
        return false;
      },
      deleteCustomWebhookIntegration: async (
        _id: string,
        _version: number,
        generation: string | null,
      ) => {
        deleteGeneration = generation;
        return false;
      },
      acquireDeletionMarker: async () => true,
      releaseDeletionMarker: async () => undefined,
    };
    const durable = new ControlPlane({ secretEncryptor: encryptor(), storage: storage as never });
    await expect(
      durable.updateCustomWebhookIntegration(config({ secret: undefined })),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    await expect(durable.deleteCustomWebhookIntegration("deploy")).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(putGeneration).toBeNull();
    expect(deleteGeneration).toBeNull();
  });
});
