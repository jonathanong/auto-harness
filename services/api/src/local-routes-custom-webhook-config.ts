/* eslint-disable max-lines -- config route keeps strict parsing and durable audit fences co-located. */
import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import type { CustomWebhookConfigInput } from "./custom-webhook-types.ts";
import { isValidCustomWebhookId } from "./custom-webhook-types.ts";

const CONFIG_PATH = /^\/api\/v1\/integrations\/custom\/([^/]+)$/;

/** Admin-only operator configuration; encrypted secrets never appear in responses or audit. */
export async function handleCustomWebhookConfigRoutes(ctx: RouteCtx): Promise<boolean> {
  const match = CONFIG_PATH.exec(ctx.url.pathname);
  if (!match) return false;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    send(ctx.res, 404, { error: { code: "NOT_FOUND", message: "integration not found" } });
    return true;
  }
  if (!isValidCustomWebhookId(id)) {
    send(ctx.res, 404, { error: { code: "NOT_FOUND", message: "integration not found" } });
    return true;
  }
  if (ctx.method === "GET") {
    try {
      const integration = await ctx.plane.getCustomWebhookIntegration(id);
      if (!integration)
        send(ctx.res, 404, { error: { code: "NOT_FOUND", message: "integration not found" } });
      else send(ctx.res, 200, integration);
    } catch {
      sendInternalError(ctx.res);
    }
    return true;
  }
  if (ctx.method === "DELETE") {
    let expectedVersion: number;
    let expectedGeneration: string | null;
    try {
      expectedVersion = parseExpectedVersion(ctx.req.headers["if-match"]);
      expectedGeneration = parseExpectedGeneration(ctx.req.headers["if-match-generation"]);
    } catch (error) {
      if (!(await audit(ctx, id, "failed"))) return true;
      send(ctx.res, 400, {
        error: {
          code: "VALIDATION_ERROR",
          message: error instanceof Error ? error.message : "invalid version fence",
        },
      });
      return true;
    }
    try {
      const current = await ctx.plane.getCustomWebhookIntegration(id);
      const result = await ctx.plane.deleteCustomWebhookIntegration(
        id,
        expectedVersion,
        expectedGeneration,
      );
      if (!result.ok) {
        if (!(await audit(ctx, id, "failed", current?.repositoryId))) return true;
        send(ctx.res, result.conflict ? 409 : 404, {
          error: { code: result.conflict ? "CONFLICT" : "NOT_FOUND", message: result.error },
        });
      } else if (await audit(ctx, id, "success", current?.repositoryId)) send(ctx.res, 204, null);
    } catch {
      if (!(await audit(ctx, id, "failed"))) return true;
      sendInternalError(ctx.res);
    }
    return true;
  }
  if (ctx.method !== "POST" && ctx.method !== "PUT") return false;
  let input: CustomWebhookConfigInput;
  let expectedVersion: number | undefined;
  let expectedGeneration: string | null | undefined;
  let currentForAudit:
    | Awaited<ReturnType<RouteCtx["plane"]["getCustomWebhookIntegration"]>>
    | undefined;
  try {
    const value = await readJson(ctx.req);
    if (ctx.method === "PUT") {
      currentForAudit = await ctx.plane.getCustomWebhookIntegration(id);
    }
    input = parseConfig(value, id, ctx.method === "POST");
    if (ctx.method === "PUT") {
      expectedVersion = parseBodyVersion(value);
      expectedGeneration = parseBodyGeneration(value);
    }
  } catch (error) {
    if (!(await audit(ctx, id, "failed", currentForAudit?.repositoryId))) return true;
    send(ctx.res, 400, {
      error: {
        code: "VALIDATION_ERROR",
        message: error instanceof Error ? error.message : "invalid configuration",
      },
    });
    return true;
  }
  try {
    // A failed replacement must remain visible to operators of the existing repository rather
    // than trusting a caller-supplied replacement repository ID for audit scope.
    const current = ctx.method === "PUT" ? currentForAudit : undefined;
    const result =
      ctx.method === "POST"
        ? await ctx.plane.createCustomWebhookIntegration(input)
        : await ctx.plane.updateCustomWebhookIntegration(
            input,
            expectedVersion,
            expectedGeneration,
          );
    if (!result.ok) {
      if (!(await audit(ctx, id, "failed", current?.repositoryId ?? input.repositoryId)))
        return true;
      const status = result.unavailable
        ? 500
        : result.conflict
          ? 409
          : result.error.endsWith("not found")
            ? 404
            : 400;
      send(ctx.res, status, {
        error: {
          code: result.unavailable
            ? "INTERNAL_ERROR"
            : result.conflict
              ? "CONFLICT"
              : status === 404
                ? "NOT_FOUND"
                : "VALIDATION_ERROR",
          message: result.error,
        },
      });
      return true;
    }
    if (await audit(ctx, id, "success", result.integration.repositoryId))
      send(ctx.res, ctx.method === "POST" ? 201 : 200, result.integration);
  } catch {
    if (!(await audit(ctx, id, "failed"))) return true;
    sendInternalError(ctx.res);
  }
  return true;
}

function parseConfig(value: unknown, id: string, requireSecret: boolean): CustomWebhookConfigInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("configuration must be an object");
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "secret",
    "repositoryId",
    "target",
    "fallbacks",
    "queueTtlSeconds",
    "timeout",
    "priority",
    "requiredLabels",
    "enabled",
    "version",
    "generation",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new Error("configuration contains an unsupported field");
  if (requireSecret && body.version !== undefined)
    throw new Error("configuration contains an unsupported field");
  if (requireSecret && typeof body.secret !== "string") throw new Error("secret is required");
  if (!requireSecret && body.secret !== undefined && typeof body.secret !== "string")
    throw new Error("secret must be a string when set");
  if (typeof body.repositoryId !== "string") throw new Error("repositoryId is required");
  if (!body.target || typeof body.target !== "object" || Array.isArray(body.target))
    throw new Error("target is required");
  if (body.timeout === undefined || typeof body.timeout !== "number")
    throw new Error("timeout is required");
  if (body.fallbacks !== undefined && !Array.isArray(body.fallbacks))
    throw new Error("fallbacks must be an array");
  if (body.requiredLabels !== undefined && !Array.isArray(body.requiredLabels))
    throw new Error("requiredLabels must be an array");
  return {
    id,
    ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
    repositoryId: body.repositoryId,
    target: body.target as CustomWebhookConfigInput["target"],
    ...(Array.isArray(body.fallbacks)
      ? { fallbacks: body.fallbacks as CustomWebhookConfigInput["fallbacks"] & object }
      : {}),
    ...(body.queueTtlSeconds !== undefined
      ? { queueTtlSeconds: body.queueTtlSeconds as number }
      : {}),
    timeout: body.timeout,
    ...(body.priority !== undefined ? { priority: body.priority as number } : {}),
    ...(body.requiredLabels !== undefined
      ? { requiredLabels: body.requiredLabels as string[] }
      : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
  };
}

function parseBodyVersion(value: unknown): number {
  const version = (value as { version?: unknown }).version;
  if (!Number.isSafeInteger(version) || (version as number) < 1)
    throw new Error("version must be a positive integer");
  return version as number;
}

function parseBodyGeneration(value: unknown): string | null {
  const generation = (value as { generation?: unknown }).generation;
  if (generation === "legacy") return null;
  if (typeof generation !== "string" || generation.length === 0)
    throw new Error("generation must contain the observed integration generation");
  return generation;
}

function parseExpectedVersion(value: string | string[] | undefined): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new Error("If-Match must contain the observed positive integer version");
  const version = Number(value);
  if (!Number.isSafeInteger(version)) throw new Error("If-Match version is too large");
  return version;
}

function parseExpectedGeneration(value: string | string[] | undefined): string | null {
  if (value === "legacy") return null;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("If-Match-Generation must contain the observed integration generation");
  return value;
}

function audit(
  ctx: RouteCtx,
  id: string,
  outcome: "success" | "failed",
  repositoryId?: string,
): Promise<boolean> {
  const verb = ctx.method === "POST" ? "create" : ctx.method === "PUT" ? "update" : "delete";
  return writeRouteAudit(ctx, {
    action: `integration:custom-webhook:${verb}`,
    resourceType: "integration",
    resourceId: id,
    outcome,
    ...(repositoryId ? { repositoryId } : {}),
  });
}
