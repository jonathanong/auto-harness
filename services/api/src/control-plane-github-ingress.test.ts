/* eslint-disable max-lines -- config lifecycle and CAS edge cases share fixtures. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  decryptGitHubIngressSecret,
  MAX_GITHUB_INGRESS_CATALOG_REFS,
  MAX_GITHUB_INGRESS_CONFIG_BYTES,
} from "./control-plane-github-ingress.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { GitHubIngressConfigRecord } from "./db/plane-storage-types.ts";

const encryptor: SecretEncryptor = {
  encrypt: async (value) => `cipher:${value}`,
  decrypt: async (value) => value.slice("cipher:".length),
};

const binding = {
  githubRepositoryId: 42,
  repositoryId: "repo",
  target: { commandId: "command" },
  timeout: 60,
  defaultRef: "refs/heads/main",
};

function createPlane() {
  const instance = new ControlPlane({ secretEncryptor: encryptor });
  instance.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
  instance.createCommand({ id: "command", name: "command", argv: ["echo"] });
  return instance;
}

function conflictStorage(record: GitHubIngressConfigRecord | null) {
  return {
    getGitHubIngressConfig: async () => record,
    putGitHubIngressConfig: async () => false,
    deleteGitHubIngressConfig: async () => false,
    getRepository: async () => ({ id: "repo", name: "repo", url: "https://example.test/repo" }),
    listCommands: async () => [
      { id: "command", name: "command", argv: ["echo"], providerId: null },
    ],
    listProviders: async () => [],
    listProviderAccounts: async () => [],
  };
}

describe("GitHub ingress config", () => {
  it("retains a secret on update and exposes no plaintext", async () => {
    const plane = createPlane();
    await expect(
      plane.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding] }),
    ).resolves.toMatchObject({ ok: true, integration: { secretConfigured: true } });
    await expect(
      plane.updateGitHubIngressConfig({ enabled: false, bindings: [binding] }),
    ).resolves.toMatchObject({ ok: true, integration: { enabled: false, secretConfigured: true } });
    await expect(plane.getGitHubIngressConfig()).resolves.toMatchObject({ secretConfigured: true });
  });

  it("validates bindings while repository admission is paused or draining", async () => {
    const paused = createPlane();
    paused.state.repositories.get("repo")!.admissionState = "paused";
    await expect(
      paused.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding] }),
    ).resolves.toMatchObject({ ok: true });

    const draining = createPlane();
    await expect(
      draining.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding] }),
    ).resolves.toMatchObject({ ok: true });
    draining.state.repositories.get("repo")!.admissionState = "draining";
    await expect(
      draining.updateGitHubIngressConfig({ bindings: [binding] }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects duplicate repository bindings and missing create secrets", async () => {
    const plane = createPlane();
    await expect(plane.createGitHubIngressConfig({ bindings: [binding] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("secret"),
    });
    await expect(
      plane.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding, binding] }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("unique") });
    await expect(
      plane.createGitHubIngressConfig({
        secret: "x".repeat(16),
        bindings: [{ ...binding, repositoryId: "missing" }],
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("covers validation bounds, provider routing, unavailable KMS, and missing lifecycle rows", async () => {
    const plane = createPlane();
    const providerBinding = {
      ...binding,
      target: { providerId: "provider" },
      fallbacks: [{ commandId: "command" }],
    };
    plane.createProvider({ id: "provider", name: "provider", defaultCommandId: "command" });
    await expect(
      plane.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [providerBinding] }),
    ).resolves.toMatchObject({
      ok: true,
      integration: { bindings: [{ target: { providerId: "provider" } }] },
    });
    await expect(
      plane.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding] }),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    await expect(plane.updateGitHubIngressConfig({ bindings: [] })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      plane.updateGitHubIngressConfig({
        bindings: [{ ...binding, target: { commandId: "missing" } }],
      }),
    ).resolves.toMatchObject({ ok: false });
    plane.state.secretEncryptor = undefined;
    await expect(plane.updateGitHubIngressConfig({ bindings: [binding] })).resolves.toMatchObject({
      ok: false,
      unavailable: true,
    });

    const empty = createPlane();
    await expect(empty.updateGitHubIngressConfig({ bindings: [binding] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not found"),
    });
    await expect(empty.deleteGitHubIngressConfig()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not found"),
    });
    empty.state.secretEncryptor = undefined;
    await expect(
      empty.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding] }),
    ).resolves.toMatchObject({ ok: false, unavailable: true });
    await expect(
      decryptGitHubIngressSecret(empty.state, {
        id: "github-ingress",
        type: "github-ingress",
        encryptedSecret: "cipher",
        enabled: true,
        bindings: [],
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("rejects unsafe refs, invalid login lists, and malformed secret ciphertext", async () => {
    const plane = createPlane();
    for (const invalid of [
      { defaultRef: "-main" },
      { defaultRef: "bad ref" },
      { allowedLogins: [""] },
      { allowedLogins: ["x".repeat(40)] },
      { allowedLogins: Array.from({ length: 101 }, () => "login") },
      { githubRepositoryId: Number.MAX_SAFE_INTEGER + 1 },
      { timeout: 0 },
      { priority: 1.5 },
      { fallbacks: [{ commandId: "command" }, { commandId: "command" }] },
      { repositoryId: "r".repeat(257) },
    ]) {
      await expect(
        plane.createGitHubIngressConfig({
          secret: "x".repeat(16),
          bindings: [{ ...binding, ...invalid }],
        }),
        JSON.stringify(invalid),
      ).resolves.toMatchObject({ ok: false });
    }
    await expect(
      plane.createGitHubIngressConfig({
        secret: "x".repeat(16),
        enabled: "yes" as never,
        bindings: [binding],
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      plane.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [] }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      plane.createGitHubIngressConfig({
        secret: "x".repeat(16),
        bindings: Array.from({ length: 101 }, (_, index) => ({
          ...binding,
          githubRepositoryId: index + 1,
        })),
      }),
    ).resolves.toMatchObject({ ok: false });
    const malformed = createPlane();
    await expect(
      malformed.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding] }),
    ).resolves.toMatchObject({ ok: true });
    const record = await malformed.getGitHubIngressConfigRecord();
    expect(record).not.toBeNull();
    malformed.state.secretEncryptor = {
      encrypt: async () => "cipher",
      decrypt: async () => "not-json",
    };
    await expect(decryptGitHubIngressSecret(malformed.state, record!)).rejects.toThrow(
      "Unexpected token",
    );
    malformed.state.secretEncryptor.decrypt = async () => JSON.stringify({ secret: 42 });
    await expect(decryptGitHubIngressSecret(malformed.state, record!)).rejects.toThrow(
      "ciphertext is invalid",
    );
    malformed.state.secretEncryptor.decrypt = async () => JSON.stringify({ secret: "ok" });
    await expect(decryptGitHubIngressSecret(malformed.state, record!)).resolves.toBe("ok");
  });

  it("bounds the aggregate item size and fenced catalog references", async () => {
    const oversized = createPlane();
    const largeLogins = Array.from({ length: 100 }, () => "x".repeat(39));
    await expect(
      oversized.createGitHubIngressConfig({
        secret: "x".repeat(16),
        bindings: Array.from({ length: 100 }, (_, index) => ({
          ...binding,
          githubRepositoryId: index + 1,
          allowedLogins: largeLogins,
        })),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(`at most ${MAX_GITHUB_INGRESS_CONFIG_BYTES} bytes`),
    });

    const nearLimit = createPlane();
    await expect(
      nearLimit.createGitHubIngressConfig({
        secret: "x".repeat(16),
        bindings: Array.from({ length: 68 }, (_, index) => ({
          ...binding,
          githubRepositoryId: index + 1,
          allowedLogins: largeLogins,
        })),
      }),
    ).resolves.toMatchObject({ ok: true });

    const tooManyReferences = createPlane();
    await expect(
      tooManyReferences.createGitHubIngressConfig({
        secret: "x".repeat(16),
        bindings: Array.from({ length: 100 }, (_, index) => ({
          ...binding,
          githubRepositoryId: index + 1,
          repositoryId: `repository-${index}`,
        })),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(
        `at most ${MAX_GITHUB_INGRESS_CATALOG_REFS} unique catalog entries`,
      ),
    });
  });

  it("fences durable writes against referenced catalog deletion", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    let markers: unknown;
    const storage = {
      getRepository: async () => ({ id: "repo" }),
      listProviders: async () => [],
      listCommands: async () => [
        { id: "command", name: "command", argv: ["echo"], providerId: null },
      ],
      listProviderAccounts: async () => [],
      getGitHubIngressConfig: async () => null,
      acquireDeletionMarker: async (key: string) => {
        acquired.push(key);
        return true;
      },
      releaseDeletionMarker: async (key: string) => void released.push(key),
      putGitHubIngressConfig: async (_record: unknown, _version: unknown, value: unknown) => {
        markers = value;
        return true;
      },
    };
    const plane = new ControlPlane({ secretEncryptor: encryptor, storage: storage as never });
    const result = await plane.createGitHubIngressConfig({
      secret: "x".repeat(16),
      bindings: [binding],
    });
    expect(result).toMatchObject({ ok: true });
    expect(acquired).toEqual(["command:command", "repository:repo"]);
    expect(markers).toEqual([
      { key: "repository:repo", owner: expect.any(String), now: expect.any(String) },
      { key: "command:command", owner: expect.any(String), now: expect.any(String) },
    ]);
    expect(released).toEqual(["command:command", "repository:repo"]);
  });

  it("returns durable create, update, and delete CAS conflicts", async () => {
    const current = {
      id: "github-ingress",
      type: "github-ingress",
      encryptedSecret: 'cipher:{"secret":"secret"}',
      enabled: true,
      bindings: [
        {
          githubRepositoryId: 42,
          repositoryId: "repo",
          target: { commandId: "command" },
          fallbacks: [],
          queueTtlSeconds: 3600,
          timeout: 60,
          priority: 0,
          requiredLabels: [],
          defaultRef: "refs/heads/main",
          allowedLogins: [],
        },
      ],
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const create = createPlane();
    create.state.storage = conflictStorage(null) as never;
    await expect(
      create.createGitHubIngressConfig({ secret: "x".repeat(16), bindings: [binding] }),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    const update = createPlane();
    update.state.storage = conflictStorage(current) as never;
    await expect(update.updateGitHubIngressConfig({ bindings: [binding] })).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    const remove = createPlane();
    remove.state.storage = conflictStorage(current) as never;
    await expect(remove.deleteGitHubIngressConfig()).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
  });
});
