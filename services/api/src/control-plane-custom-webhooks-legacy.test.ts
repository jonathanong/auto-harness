import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  decryptCustomWebhookSecret,
  validateConfiguredTargetReferences,
} from "./control-plane-custom-webhooks.ts";

describe("legacy custom webhook integrations", () => {
  it("allows GitHub ingress comment concurrency ids without durable storage", async () => {
    const plane = new ControlPlane();
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
    plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
    const body = {
      repositoryId: "repo",
      prompt: "fix this",
      target: { commandId: "command" },
      timeout: 60,
      concurrencyId: "github-comment:issue_comment:42:99",
    };

    await expect(plane.createSessionDurable(body)).resolves.toMatchObject({ ok: false });
    await expect(plane.createGitHubIngressSessionDurable(body)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
  });

  it("assigns a generation on the next operator update", async () => {
    const plane = new ControlPlane({
      secretEncryptor: {
        encrypt: async (value) => `cipher:${value}`,
        decrypt: async (value) => value.slice("cipher:".length),
      },
    });
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
    plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
    await plane.createCustomWebhookIntegration({
      id: "deploy",
      secret: "s".repeat(32),
      repositoryId: "repo",
      target: { commandId: "command" },
      timeout: 60,
    });
    const legacy = await plane.getCustomWebhookIntegrationRecord("deploy");
    expect(legacy).not.toBeNull();
    delete legacy!.generation;
    await expect(plane.getCustomWebhookIntegration("deploy")).resolves.toMatchObject({
      generation: "legacy",
    });

    await expect(
      plane.updateCustomWebhookIntegration({
        id: "deploy",
        repositoryId: "repo",
        target: { commandId: "command" },
        timeout: 90,
      }),
    ).resolves.toMatchObject({ ok: true, integration: { version: 2 } });
    expect(await plane.getCustomWebhookIntegrationRecord("deploy")).toMatchObject({
      generation: expect.any(String),
    });
  });

  it("rejects absent catalog references and malformed legacy ciphertext", async () => {
    const plane = new ControlPlane({
      secretEncryptor: {
        encrypt: async (value) => `cipher:${value}`,
        decrypt: async (value) => value.slice("cipher:".length),
      },
    });
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
    plane.createProvider({ id: "provider", name: "provider", defaultCommandId: null });
    await expect(
      validateConfiguredTargetReferences(plane.state, "missing", { providerId: "provider" }),
    ).resolves.toMatchObject({ ok: false, error: "repository not found" });
    await expect(
      validateConfiguredTargetReferences(plane.state, "repo", { providerId: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: "providerId missing not found" });
    await expect(
      validateConfiguredTargetReferences(plane.state, "repo", { commandId: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: "commandId missing not found" });

    const record = {
      id: "deploy",
      type: "custom-webhook" as const,
      encryptedSecret: "cipher",
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [],
      queueTtlSeconds: 60,
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      enabled: true,
      version: 1,
      createdAt: "now",
      updatedAt: "now",
    };
    plane.state.secretEncryptor = undefined;
    await expect(decryptCustomWebhookSecret(plane.state, "deploy", record)).rejects.toThrow(
      "unavailable",
    );
    for (const plaintext of ["{}", '{"secret": 1}']) {
      plane.state.secretEncryptor = {
        encrypt: async (value) => value,
        decrypt: async () => plaintext,
      };
      await expect(decryptCustomWebhookSecret(plane.state, "deploy", record)).rejects.toThrow(
        "invalid",
      );
    }
  });
});
