/* eslint-disable max-lines -- ingress edge cases share the same signed fixture. */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const secret = "s".repeat(32);

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (value) => `cipher:${Buffer.from(value).toString("base64")}`,
    decrypt: async (value) => Buffer.from(value.slice("cipher:".length), "base64").toString("utf8"),
  };
}

async function fixture() {
  const plane = new ControlPlane({ secretEncryptor: encryptor(), idFactory: () => "session-1" });
  plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
  plane.createProvider({ id: "provider", name: "provider", defaultCommandId: "command" });
  plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: "provider" });
  await plane.createCustomWebhookIntegration({
    id: "deploy",
    secret,
    repositoryId: "repo",
    target: { providerId: "provider" },
    timeout: 60,
  });
  return {
    plane,
    handler: createLocalApp({ plane, authMode: "disabled", rateLimitConfig: { enabled: false } })
      .handler,
  };
}

function signature(body: unknown): string {
  const bytes = Buffer.from(JSON.stringify(body));
  return `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
}

describe("custom webhook receiver", () => {
  it("exposes CRUD configuration without returning the encrypted secret", async () => {
    const { handler } = await fixture();
    const loaded = await invokeHandler(handler, "GET", "/api/v1/integrations/custom/deploy");
    expect(loaded).toMatchObject({ status: 200, json: { id: "deploy", secretConfigured: true } });
    expect(JSON.stringify(loaded.json)).not.toContain("encryptedSecret");
    const updated = await invokeHandler(handler, "PUT", "/api/v1/integrations/custom/deploy", {
      repositoryId: "repo",
      target: { providerId: "provider" },
      timeout: 90,
      enabled: false,
    });
    expect(updated).toMatchObject({ status: 200, json: { enabled: false } });
    expect(
      (await invokeHandler(handler, "DELETE", "/api/v1/integrations/custom/deploy")).status,
    ).toBe(204);
    expect((await invokeHandler(handler, "GET", "/api/v1/integrations/custom/deploy")).status).toBe(
      404,
    );
  });

  it("verifies the raw body, applies operator routing, and asynchronously acknowledges", async () => {
    const { plane, handler } = await fixture();
    const body = { prompt: "run deploy", idempotencyKey: "delivery-1", ref: "main" };
    const response = await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body, {
      "x-auto-harness-signature-256": signature(body),
    });
    expect(response).toMatchObject({
      status: 202,
      json: { sessionId: "session-1", created: true },
    });
    expect(plane.getSession("session-1")).toMatchObject({
      repositoryId: "repo",
      source: "webhook",
      concurrencyId: "webhook:deploy:delivery-1",
      target: { providerId: "provider" },
    });
  });

  it("rejects bad signatures and caller routing/metadata fields", async () => {
    const { handler } = await fixture();
    const bad = await invokeHandler(
      handler,
      "POST",
      "/api/v1/webhooks/custom/deploy",
      { prompt: "x", idempotencyKey: "one" },
      { "x-auto-harness-signature-256": "sha256=" + "0".repeat(64) },
    );
    expect(bad.status).toBe(401);
    const body = { prompt: "x", idempotencyKey: "one", repositoryId: "attacker" };
    const extra = await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body, {
      "x-auto-harness-signature-256": signature(body),
    });
    expect(extra).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
  });

  it("deduplicates concurrent redelivery and requires signatures", async () => {
    const { plane, handler } = await fixture();
    const body = { prompt: "x", idempotencyKey: "same" };
    const headers = { "x-auto-harness-signature-256": signature(body) };
    const [first, second] = await Promise.all([
      invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body, headers),
      invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body, headers),
    ]);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(plane.listSessions()).toHaveLength(1);
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body)).status,
    ).toBe(401);
  });

  it("rejects unsupported methods, missing integrations, malformed ids, invalid refs, and oversized prompts", async () => {
    const { handler } = await fixture();
    expect((await invokeHandler(handler, "GET", "/api/v1/webhooks/custom/deploy")).status).toBe(
      405,
    );
    expect((await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/missing")).status).toBe(
      404,
    );
    expect((await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/%E0%A4%A")).status).toBe(
      404,
    );
    const invalidRef = { prompt: "x", idempotencyKey: "bad-ref", ref: "--bad" };
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", invalidRef, {
          "x-auto-harness-signature-256": signature(invalidRef),
        })
      ).status,
    ).toBe(400);
    const oversized = { prompt: "p".repeat(65 * 1024), idempotencyKey: "large" };
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", oversized, {
          "x-auto-harness-signature-256": signature(oversized),
        })
      ).status,
    ).toBe(400);
    const oversizedUtf8 = { prompt: "é".repeat(32_769), idempotencyKey: "utf8-large" };
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", oversizedUtf8, {
          "x-auto-harness-signature-256": signature(oversizedUtf8),
        })
      ).status,
    ).toBe(400);
  });

  it("does not accept disabled integrations and fails closed when audit persistence fails", async () => {
    const { plane, handler } = await fixture();
    expect(
      (
        await plane.updateCustomWebhookIntegration({
          id: "deploy",
          repositoryId: "repo",
          target: { providerId: "provider" },
          timeout: 60,
          enabled: false,
        })
      ).ok,
    ).toBe(true);
    const body = { prompt: "x", idempotencyKey: "disabled" };
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body, {
          "x-auto-harness-signature-256": signature(body),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await plane.updateCustomWebhookIntegration({
          id: "deploy",
          repositoryId: "repo",
          target: { providerId: "provider" },
          timeout: 60,
          enabled: true,
        })
      ).ok,
    ).toBe(true);
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body, {
          "x-auto-harness-signature-256": signature(body),
        })
      ).status,
    ).toBe(500);
  });

  it("rejects an in-flight create whose integration version was rotated", async () => {
    const { plane } = await fixture();
    const old = await plane.integrations.getCustomWebhookIntegrationRecord("deploy");
    expect(old).not.toBeNull();
    await plane.updateCustomWebhookIntegration({
      id: "deploy",
      repositoryId: "repo",
      target: { providerId: "provider" },
      timeout: 60,
    });
    await expect(
      plane.sessions.createSessionDurable(
        {
          repositoryId: "repo",
          prompt: "x",
          target: { providerId: "provider" },
          timeout: 60,
          concurrencyId: "webhook:deploy:stale",
          metadata: { integrationId: "deploy" },
          source: "webhook",
          type: "prompt",
        },
        {
          integrationFence: {
            id: "deploy",
            type: "custom-webhook",
            storageId: "custom-webhook:deploy",
            version: old!.version,
            enabled: true,
          },
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
  });
});
