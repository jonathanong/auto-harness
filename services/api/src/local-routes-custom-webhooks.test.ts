/* eslint-disable max-lines -- ingress edge cases share the same signed fixture. */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { handleCustomWebhookConfigRoutes } from "./local-routes-custom-webhook-config.ts";
import { handleCustomWebhookRoute } from "./local-routes-custom-webhooks.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { invokeBadJson, invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

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

function directRoute(
  plane: ControlPlane,
  path: string,
  method: string,
  body = Buffer.alloc(0),
  headers: Record<string, string> = {},
  throwWhenWriting = false,
) {
  let status = 0;
  const req = {
    headers,
    destroy() {
      /* simulate a terminated oversized request */
    },
    on(event: string, callback: (value?: Buffer) => void) {
      if (event === "data" && body.length) callback(body);
      if (event === "end") callback();
      return req;
    },
  };
  const res = {
    setHeader() {
      if (throwWhenWriting) throw new Error("response unavailable");
      /* response payload is not material to direct route guards */
    },
    writeHead(value: number) {
      status = value;
    },
    end() {
      /* response payload is not material to direct route guards */
    },
  };
  return {
    ctx: { plane, req, res, url: new URL(`http://local.test${path}`), method },
    status: () => status,
  };
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

  it("covers configuration CRUD validation, conflicts, and storage failures", async () => {
    const { plane, handler } = await fixture();
    const complete = {
      secret: "n".repeat(32),
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [{ commandId: "command" }],
      queueTtlSeconds: 120,
      timeout: 60,
      priority: 1,
      requiredLabels: ["release"],
      enabled: true,
    };
    expect(
      await invokeHandler(handler, "POST", "/api/v1/integrations/custom/new-hook", complete),
    ).toMatchObject({ status: 201, json: { id: "new-hook" } });
    expect(
      await invokeHandler(handler, "POST", "/api/v1/integrations/custom/new-hook", complete),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
    expect(
      await invokeHandler(handler, "PUT", "/api/v1/integrations/custom/missing", {
        ...complete,
        secret: undefined,
      }),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    for (const [id, body] of [
      ["not-object", null],
      ["unknown", { ...complete, surprise: true }],
      ["missing-secret", { ...complete, secret: undefined }],
      ["secret-type", { ...complete, secret: 1 }],
      ["missing-repository", { ...complete, repositoryId: undefined }],
      ["missing-target", { ...complete, target: undefined }],
      ["missing-timeout", { ...complete, timeout: undefined }],
      ["bad-fallbacks", { ...complete, fallbacks: {} }],
      ["bad-labels", { ...complete, requiredLabels: {} }],
    ]) {
      expect(
        await invokeHandler(handler, "POST", `/api/v1/integrations/custom/${id}`, body),
      ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    }
    expect(await invokeBadJson(handler, "POST", "/api/v1/integrations/custom/bad-json")).toBe(400);
    expect(
      await invokeHandler(handler, "PUT", "/api/v1/integrations/custom/deploy", {
        ...complete,
        secret: 1,
      }),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });

    const malformedConfig = directRoute(plane, "/api/v1/integrations/custom/%E0%A4%A", "GET");
    await expect(handleCustomWebhookConfigRoutes(malformedConfig.ctx as never)).resolves.toBe(true);
    expect(malformedConfig.status()).toBe(404);
    const invalidConfig = directRoute(plane, "/api/v1/integrations/custom/bad%20id", "GET");
    await expect(handleCustomWebhookConfigRoutes(invalidConfig.ctx as never)).resolves.toBe(true);
    expect(invalidConfig.status()).toBe(404);

    const mutable = plane as unknown as {
      getCustomWebhookIntegration: (id: string) => Promise<never>;
      deleteCustomWebhookIntegration: (id: string) => Promise<unknown>;
      createCustomWebhookIntegration: (input: unknown) => Promise<unknown>;
    };
    mutable.getCustomWebhookIntegration = async () => {
      throw new Error("storage unavailable");
    };
    expect(await invokeHandler(handler, "GET", "/api/v1/integrations/custom/deploy")).toMatchObject(
      { status: 500, json: { error: { code: "INTERNAL_ERROR" } } },
    );
    mutable.deleteCustomWebhookIntegration = async () => ({
      ok: false,
      error: "changed",
      conflict: true,
    });
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/custom/deploy"),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
    mutable.deleteCustomWebhookIntegration = async () => {
      throw new Error("storage unavailable");
    };
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/custom/deploy"),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    mutable.createCustomWebhookIntegration = async () => {
      throw new Error("storage unavailable");
    };
    expect(
      await invokeHandler(handler, "POST", "/api/v1/integrations/custom/throws", complete),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
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
    await expect(plane.listAuditLogs({ repositoryId: "repo" })).resolves.toMatchObject({
      items: [expect.objectContaining({ action: "webhook:custom:receive", outcome: "success" })],
    });
  });

  it("rejects bad signatures and caller routing/metadata fields", async () => {
    const { plane, handler } = await fixture();
    const bad = await invokeHandler(
      handler,
      "POST",
      "/api/v1/webhooks/custom/deploy",
      { prompt: "x", idempotencyKey: "one" },
      { "x-auto-harness-signature-256": "sha256=" + "0".repeat(64) },
    );
    expect(bad.status).toBe(401);
    await expect(plane.listAuditLogs({ repositoryId: "repo" })).resolves.toMatchObject({
      items: [expect.objectContaining({ action: "webhook:custom:receive", outcome: "denied" })],
    });
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
    const wrongIdempotencyKey = { prompt: "x", idempotencyKey: 1 };
    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          "/api/v1/webhooks/custom/deploy",
          wrongIdempotencyKey,
          {
            "x-auto-harness-signature-256": signature(wrongIdempotencyKey),
          },
        )
      ).status,
    ).toBe(400);
    const oversizedIdempotencyKey = { prompt: "x", idempotencyKey: "é".repeat(951) };
    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          "/api/v1/webhooks/custom/deploy",
          oversizedIdempotencyKey,
          { "x-auto-harness-signature-256": signature(oversizedIdempotencyKey) },
        )
      ).status,
    ).toBe(400);
  });

  it("returns a durable failure when assignment cannot be queued", async () => {
    const { plane, handler } = await fixture();
    plane.setOnAssignmentRequested(async () => {
      throw new Error("assignment unavailable");
    });
    const body = { prompt: "x", idempotencyKey: "queue-failure" };
    expect(
      await invokeHandler(handler, "POST", "/api/v1/webhooks/custom/deploy", body, {
        "x-auto-harness-signature-256": signature(body),
      }),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    expect(plane.listSessions()).toHaveLength(1);
  });

  it("rejects malformed raw payloads and malformed encoded integration ids", async () => {
    const { plane } = await fixture();
    for (const body of [Buffer.from("{bad"), Buffer.from("null")]) {
      const route = directRoute(plane, "/api/v1/webhooks/custom/deploy", "POST", body, {
        "x-auto-harness-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      });
      await expect(handleCustomWebhookRoute(route.ctx as never)).resolves.toBe(true);
      expect(route.status()).toBe(400);
    }
    for (const body of [
      { idempotencyKey: "missing-prompt" },
      { prompt: "x" },
      { prompt: "x", idempotencyKey: "one", ref: 1 },
    ]) {
      const raw = Buffer.from(JSON.stringify(body));
      const route = directRoute(plane, "/api/v1/webhooks/custom/deploy", "POST", raw, {
        "x-auto-harness-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      });
      await expect(handleCustomWebhookRoute(route.ctx as never)).resolves.toBe(true);
      expect(route.status()).toBe(400);
    }
    const malformedId = directRoute(plane, "/api/v1/webhooks/custom/%E0%A4%A", "POST");
    await expect(handleCustomWebhookRoute(malformedId.ctx as never)).resolves.toBe(true);
    expect(malformedId.status()).toBe(404);
    const invalidId = directRoute(plane, "/api/v1/webhooks/custom/bad%20id", "POST");
    await expect(handleCustomWebhookRoute(invalidId.ctx as never)).resolves.toBe(true);
    expect(invalidId.status()).toBe(404);
  });

  it("rejects oversized raw requests and does not create work when audit response persistence fails", async () => {
    const { plane } = await fixture();
    const oversized = directRoute(
      plane,
      "/api/v1/webhooks/custom/deploy",
      "POST",
      Buffer.alloc(1024 * 1024 + 1),
    );
    await expect(handleCustomWebhookRoute(oversized.ctx as never)).resolves.toBe(true);
    expect(oversized.status()).toBe(400);

    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const badSignature = directRoute(
      plane,
      "/api/v1/webhooks/custom/deploy",
      "POST",
      Buffer.from(JSON.stringify({ prompt: "x", idempotencyKey: "audit" })),
      { "x-auto-harness-signature-256": "sha256=" + "0".repeat(64) },
      true,
    );
    await expect(handleCustomWebhookRoute(badSignature.ctx as never)).resolves.toBe(true);
    expect(plane.listSessions()).toHaveLength(0);
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
