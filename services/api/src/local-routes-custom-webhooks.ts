import { createHmac, timingSafeEqual } from "node:crypto";

import { writeRouteAudit } from "./local-audit.ts";
import { readRawBody, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { decryptCustomWebhookSecret } from "./control-plane-custom-webhooks.ts";
import { WEBHOOK_SIGNATURE_256_HEADER } from "./webhook-delivery-types.ts";
import { isValidCustomWebhookId } from "./custom-webhook-types.ts";

const CUSTOM_WEBHOOK_PATH = /^\/api\/v1\/webhooks\/custom\/([^/]+)$/;
const MAX_IDEMPOTENCY_KEY_BYTES = 1_900;

/** Public HMAC-verified receiver. It intentionally has no authenticated principal. */
export async function handleCustomWebhookRoute(ctx: RouteCtx): Promise<boolean> {
  const match = CUSTOM_WEBHOOK_PATH.exec(ctx.url.pathname);
  if (!match) return false;
  if (ctx.method !== "POST") {
    send(ctx.res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST is required" } });
    return true;
  }
  let integrationId: string;
  try {
    integrationId = decodeURIComponent(match[1]!);
  } catch {
    send(ctx.res, 404, { error: { code: "NOT_FOUND", message: "webhook not found" } });
    return true;
  }
  if (!isValidCustomWebhookId(integrationId)) {
    send(ctx.res, 404, { error: { code: "NOT_FOUND", message: "webhook not found" } });
    return true;
  }
  let body: Buffer;
  try {
    body = await readRawBody(ctx.req);
  } catch {
    if (!(await audit(ctx, integrationId, "failed"))) return true;
    send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid request body" } });
    return true;
  }
  let repositoryId: string | undefined;
  try {
    const record = await ctx.plane.getCustomWebhookIntegrationRecord(integrationId);
    if (!record) {
      if (!(await audit(ctx, integrationId, "denied"))) return true;
      send(ctx.res, 404, { error: { code: "NOT_FOUND", message: "webhook not found" } });
      return true;
    }
    repositoryId = record.repositoryId;
    if (!record.enabled) {
      if (!(await audit(ctx, integrationId, "denied", undefined, repositoryId))) return true;
      send(ctx.res, 409, { error: { code: "DISABLED", message: "webhook is disabled" } });
      return true;
    }
    const secret = await decryptCustomWebhookSecret(ctx.plane.state, integrationId, record);
    if (!validSignature(ctx.req.headers[WEBHOOK_SIGNATURE_256_HEADER], body, secret)) {
      if (!(await audit(ctx, integrationId, "denied", undefined, repositoryId))) return true;
      send(ctx.res, 401, {
        error: { code: "UNAUTHENTICATED", message: "invalid webhook signature" },
      });
      return true;
    }
    const parsed = parseCallerBody(body);
    if (!parsed.ok) {
      if (!(await audit(ctx, integrationId, "failed", undefined, repositoryId))) return true;
      send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: parsed.error } });
      return true;
    }
    const result = await ctx.plane.createCustomWebhookSessionDurable(
      {
        repositoryId: record.repositoryId,
        prompt: parsed.prompt,
        target: record.target,
        fallbacks: record.fallbacks,
        queueTtlSeconds: record.queueTtlSeconds,
        timeout: record.timeout,
        priority: record.priority,
        requiredLabels: record.requiredLabels,
        ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
        concurrencyId: `webhook:${integrationId}:${parsed.idempotencyKey}`,
        source: "webhook",
        type: "prompt",
        metadata: { integrationId },
      },
      {
        integrationFence: {
          id: integrationId,
          type: "custom-webhook",
          storageId: `custom-webhook:${integrationId}`,
          ...(record.generation === undefined ? {} : { generation: record.generation }),
          version: record.version,
          enabled: record.enabled,
        },
      },
    );
    if (!result.ok) {
      if (!(await audit(ctx, integrationId, "failed", undefined, repositoryId))) return true;
      send(
        ctx.res,
        result.code === "CONFLICT" || result.code === "REPOSITORY_ADMISSION_CLOSED" ? 409 : 400,
        {
          error: { code: result.code ?? "VALIDATION_ERROR", message: result.error },
        },
      );
      return true;
    }
    if (!(await audit(ctx, integrationId, "success", { created: result.created }, repositoryId))) {
      return true;
    }
    // Assignment is deliberately detached from the public ingress response. The durable session
    // and concurrency claim are the acknowledgment; a retry can safely observe the same claim.
    await ctx.plane.enqueueAssignment();
    send(ctx.res, 202, { accepted: true, sessionId: result.session.id, created: result.created });
  } catch {
    if (!(await audit(ctx, integrationId, "failed", undefined, repositoryId))) return true;
    sendInternalError(ctx.res);
  }
  return true;
}

function validSignature(
  value: string | string[] | undefined,
  body: Buffer,
  secret: string,
): boolean {
  if (typeof value !== "string" || !/^sha256=[0-9a-f]{64}$/.test(value)) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const supplied = Buffer.from(value);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseCallerBody(
  body: Buffer,
):
  | { ok: true; prompt: string; idempotencyKey: string; ref?: string }
  | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, error: "body must be valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "body must be an object" };
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["prompt", "idempotencyKey", "ref"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { ok: false, error: "body contains an unsupported field" };
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    return { ok: false, error: "prompt is required" };
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    return { ok: false, error: "idempotencyKey is required" };
  }
  if (new TextEncoder().encode(input.idempotencyKey).length > MAX_IDEMPOTENCY_KEY_BYTES) {
    return { ok: false, error: "idempotencyKey is too long" };
  }
  if (input.ref !== undefined && typeof input.ref !== "string") {
    return { ok: false, error: "ref must be a string when set" };
  }
  return {
    ok: true,
    prompt: input.prompt,
    idempotencyKey: input.idempotencyKey,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
  };
}

async function audit(
  ctx: RouteCtx,
  integrationId: string,
  outcome: "success" | "failed" | "denied",
  metadata?: Record<string, unknown>,
  repositoryId?: string,
): Promise<boolean> {
  try {
    return await writeRouteAudit(ctx, {
      action: "webhook:custom:receive",
      resourceType: "integration",
      resourceId: integrationId,
      outcome,
      ...(repositoryId ? { repositoryId } : {}),
      ...(metadata ? { metadata } : {}),
    });
  } catch {
    return false;
  }
}
