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
      generation: "11111111-1111-4111-8111-111111111111",
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
