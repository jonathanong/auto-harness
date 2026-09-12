import { createHmac, timingSafeEqual } from "node:crypto";

import { decryptGitHubIngressSecret } from "./control-plane-github-ingress.ts";
import { parseGitHubWebhookIngress } from "./github-webhook-ingress.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { readRawBody, send, sendInternalError, type RouteCtx } from "./local-http.ts";

const PATH = "/api/v1/webhooks/github";
const SIGNATURE_HEADER = "x-hub-signature-256";

/** Public GitHub App webhook receiver. Authentication is its exact-byte HMAC only. */
export async function handleGitHubIngressRoute(ctx: RouteCtx): Promise<boolean> {
  if (ctx.url.pathname !== PATH) return false;
  if (ctx.method !== "POST") {
    send(ctx.res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST is required" } });
    return true;
  }
  let body: Buffer;
  try {
    body = await readRawBody(ctx.req);
  } catch {
    return respondAudited(ctx, "failed", 400, "VALIDATION_ERROR", "invalid request body");
  }
  try {
    const record = await ctx.plane.getGitHubIngressConfigRecord();
    if (!record || !record.enabled) {
      return respondAudited(ctx, "denied", 404, "NOT_FOUND", "GitHub webhook is not configured");
    }
    const secret = await decryptGitHubIngressSecret(ctx.plane.state, record);
    if (!validSignature(ctx.req.headers[SIGNATURE_HEADER], body, secret)) {
      return respondAudited(ctx, "denied", 401, "UNAUTHENTICATED", "invalid webhook signature");
    }
    const event = ctx.req.headers["x-github-event"];
    const delivery = ctx.req.headers["x-github-delivery"];
    if (typeof event !== "string" || typeof delivery !== "string" || !safeDelivery(delivery)) {
      return respondAudited(
        ctx,
        "failed",
        400,
        "VALIDATION_ERROR",
        "missing GitHub delivery headers",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return respondAudited(ctx, "failed", 400, "VALIDATION_ERROR", "body must be valid JSON");
    }
    const parsed = parseGitHubWebhookIngress({
      event,
      payload,
      repositories: record.bindings,
    });
    if (parsed.kind === "ignored") {
      // A verified but irrelevant GitHub delivery is acknowledged to avoid retries.
      if (!(await audit(ctx, "denied", { reason: parsed.reason, delivery }, parsed.repositoryId)))
        return true;
      send(ctx.res, 202, { accepted: false, reason: parsed.reason });
      return true;
    }
    const session = parsed.session;
    const result = await ctx.plane.createGitHubIngressSessionDurable(
      {
        repositoryId: session.repositoryId,
        target: session.target,
        ...(session.fallbacks ? { fallbacks: session.fallbacks } : {}),
        prompt: session.prompt,
        ref: session.ref,
        concurrencyId: session.concurrencyId,
        source: session.source,
        type: "prompt",
        metadata: { ...session.metadata, githubDelivery: delivery },
        ...bindingExecution(record.bindings, session.metadata.githubRepositoryId),
      },
      {
        integrationFence: {
          id: "github-ingress",
          type: "github-ingress",
          storageId: "github-ingress",
          version: record.version,
          enabled: record.enabled,
        },
      },
    );
    if (!result.ok) {
      if (
        !(await audit(
          ctx,
          "failed",
          { delivery, code: result.code ?? "VALIDATION_ERROR" },
          session.repositoryId,
        ))
      )
        return true;
      send(
        ctx.res,
        result.code === "CONFLICT" || result.code === "REPOSITORY_ADMISSION_CLOSED" ? 409 : 400,
        { error: { code: result.code ?? "VALIDATION_ERROR", message: result.error } },
      );
      return true;
    }
    if (!(await audit(ctx, "success", { delivery, created: result.created }, session.repositoryId)))
      return true;
    await ctx.plane.enqueueAssignment();
    send(ctx.res, 202, { accepted: true, sessionId: result.session.id, created: result.created });
  } catch {
    if (!(await audit(ctx, "failed"))) return true;
    sendInternalError(ctx.res);
  }
  return true;
}

function safeDelivery(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function bindingExecution(
  bindings: ReadonlyArray<{
    githubRepositoryId: number;
    queueTtlSeconds: number;
    timeout: number;
    priority: number;
    requiredLabels: string[];
  }>,
  githubRepositoryId: number,
) {
  const binding = bindings.find((candidate) => candidate.githubRepositoryId === githubRepositoryId);
  // The parser accepted only an exact configured binding; this is a defensive hard stop.
  if (!binding) throw new Error("GitHub ingress binding disappeared");
  return {
    queueTtlSeconds: binding.queueTtlSeconds,
    timeout: binding.timeout,
    priority: binding.priority,
    requiredLabels: binding.requiredLabels,
  };
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

async function respondAudited(
  ctx: RouteCtx,
  outcome: "failed" | "denied",
  status: number,
  code: string,
  message: string,
): Promise<boolean> {
  if (!(await audit(ctx, outcome))) return true;
  send(ctx.res, status, { error: { code, message } });
  return true;
}

function audit(
  ctx: RouteCtx,
  outcome: "success" | "failed" | "denied",
  metadata?: Record<string, unknown>,
  repositoryId?: string,
): Promise<boolean> {
  return writeRouteAudit(ctx, {
    action: "webhook:github:receive",
    resourceType: "integration",
    resourceId: "github-ingress",
    outcome,
    ...(repositoryId ? { repositoryId } : {}),
    ...(metadata ? { metadata } : {}),
  });
}
