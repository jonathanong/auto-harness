/* eslint-disable max-lines -- singleton config parsing, version fencing, and audited outcomes stay co-located. */
import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import type { GitHubIngressConfigInput } from "./github-ingress-types.ts";
import type { TargetRef } from "@auto-harness/shared";

const PATH = "/api/v1/integrations/github-ingress";

export async function handleGitHubIngressConfigRoutes(ctx: RouteCtx): Promise<boolean> {
  if (ctx.url.pathname !== PATH) return false;
  if (ctx.method === "GET") {
    try {
      const config = await ctx.plane.getGitHubIngressConfig();
      send(
        ctx.res,
        config ? 200 : 404,
        config ?? { error: { code: "NOT_FOUND", message: "not found" } },
      );
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
      if (await failed(ctx, "delete"))
        send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: message(error) } });
      return true;
    }
    try {
      const result = await ctx.plane.deleteGitHubIngressConfig(expectedVersion, expectedGeneration);
      if (!result.ok) return respond(ctx, result, "delete");
      if (await audit(ctx, "delete", "success")) send(ctx.res, 204, null);
    } catch {
      if (await failed(ctx, "delete")) sendInternalError(ctx.res);
    }
    return true;
  }
  if (ctx.method !== "POST" && ctx.method !== "PUT") return false;
  const action = ctx.method === "POST" ? "create" : "update";
  let input: GitHubIngressConfigInput;
  let expectedVersion: number | undefined;
  let expectedGeneration: string | null | undefined;
  try {
    const body = await readJson(ctx.req);
    input = parseConfig(body, ctx.method === "POST");
    if (ctx.method === "PUT") {
      expectedVersion = parseVersion(body);
      expectedGeneration = parseGeneration(body);
    }
  } catch (error) {
    if (!(await failed(ctx, action))) return true;
    send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: message(error) } });
    return true;
  }
  try {
    const result =
      ctx.method === "POST"
        ? await ctx.plane.createGitHubIngressConfig(input)
        : await ctx.plane.updateGitHubIngressConfig(input, expectedVersion, expectedGeneration);
    if (!result.ok) return respond(ctx, result, action);
    if (await audit(ctx, action, "success"))
      send(ctx.res, ctx.method === "POST" ? 201 : 200, result.integration);
  } catch {
    if (await failed(ctx, action)) sendInternalError(ctx.res);
  }
  return true;
}

function parseConfig(value: unknown, requireSecret: boolean): GitHubIngressConfigInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("configuration must be an object");
  const body = value as Record<string, unknown>;
  const allowed = requireSecret
    ? ["secret", "enabled", "bindings"]
    : ["secret", "enabled", "bindings", "version", "generation"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("configuration contains an unsupported field");
  }
  if (requireSecret && typeof body.secret !== "string") throw new Error("secret is required");
  if (!requireSecret && body.secret !== undefined && typeof body.secret !== "string")
    throw new Error("secret must be a string when set");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    throw new Error("enabled must be a boolean when set");
  if (!Array.isArray(body.bindings)) throw new Error("bindings must be an array");
  return {
    ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    bindings: body.bindings.map(parseBinding),
  };
}

function parseVersion(value: unknown): number {
  const version = (value as { version?: unknown }).version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("version must contain the observed positive integer version");
  }
  return version;
}

function parseGeneration(value: unknown): string | null {
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

function parseBinding(value: unknown): GitHubIngressConfigInput["bindings"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("each binding must be an object");
  }
  const binding = value as Record<string, unknown>;
  const allowed = new Set([
    "githubRepositoryId",
    "repositoryId",
    "target",
    "fallbacks",
    "queueTtlSeconds",
    "timeout",
    "priority",
    "requiredLabels",
    "defaultRef",
    "allowedLogins",
  ]);
  if (Object.keys(binding).some((key) => !allowed.has(key))) {
    throw new Error("binding contains an unsupported field");
  }
  if (typeof binding.githubRepositoryId !== "number")
    throw new Error("githubRepositoryId is required");
  if (typeof binding.repositoryId !== "string") throw new Error("repositoryId is required");
  if (!binding.target || typeof binding.target !== "object" || Array.isArray(binding.target)) {
    throw new Error("target is required");
  }
  if (typeof binding.timeout !== "number") throw new Error("timeout is required");
  if (typeof binding.defaultRef !== "string") throw new Error("defaultRef is required");
  if (binding.fallbacks !== undefined && !Array.isArray(binding.fallbacks))
    throw new Error("fallbacks must be an array");
  if (binding.requiredLabels !== undefined && !Array.isArray(binding.requiredLabels))
    throw new Error("requiredLabels must be an array");
  if (binding.allowedLogins !== undefined && !Array.isArray(binding.allowedLogins))
    throw new Error("allowedLogins must be an array");
  if (binding.queueTtlSeconds !== undefined && typeof binding.queueTtlSeconds !== "number")
    throw new Error("queueTtlSeconds must be a number");
  if (binding.priority !== undefined && typeof binding.priority !== "number")
    throw new Error("priority must be a number");
  if (
    binding.requiredLabels !== undefined &&
    binding.requiredLabels.some((label) => typeof label !== "string")
  )
    throw new Error("requiredLabels entries must be strings");
  if (
    binding.allowedLogins !== undefined &&
    binding.allowedLogins.some((login) => typeof login !== "string")
  )
    throw new Error("allowedLogins entries must be strings");
  return {
    githubRepositoryId: binding.githubRepositoryId,
    repositoryId: binding.repositoryId,
    target: parseTarget(binding.target),
    ...(binding.fallbacks === undefined ? {} : { fallbacks: binding.fallbacks.map(parseTarget) }),
    ...(binding.queueTtlSeconds === undefined ? {} : { queueTtlSeconds: binding.queueTtlSeconds }),
    timeout: binding.timeout,
    ...(binding.priority === undefined ? {} : { priority: binding.priority }),
    ...(binding.requiredLabels === undefined
      ? {}
      : { requiredLabels: binding.requiredLabels as string[] }),
    defaultRef: binding.defaultRef,
    ...(binding.allowedLogins === undefined
      ? {}
      : { allowedLogins: binding.allowedLogins as string[] }),
  };
}

function parseTarget(value: unknown): TargetRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("target must be an object");
  }
  const target = value as Record<string, unknown>;
  const keys = Object.keys(target);
  if (keys.length !== 1 || !["providerId", "commandId"].includes(keys[0]!)) {
    throw new Error("target must contain exactly one supported field");
  }
  if (keys[0] === "providerId" && typeof target.providerId === "string") {
    return { providerId: target.providerId };
  }
  if (keys[0] === "commandId" && typeof target.commandId === "string") {
    return { commandId: target.commandId };
  }
  throw new Error("target identifier must be a string");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "invalid configuration";
}

async function respond(
  ctx: RouteCtx,
  result: { error: string; conflict?: true; unavailable?: true },
  action: string,
): Promise<boolean> {
  if (!(await failed(ctx, action))) return true;
  const status = result.unavailable
    ? 500
    : result.conflict
      ? 409
      : result.error.endsWith("not found")
        ? 404
        : 400;
  send(ctx.res, status, {
    error: {
      code:
        status === 409
          ? "CONFLICT"
          : status === 404
            ? "NOT_FOUND"
            : status === 500
              ? "INTERNAL_ERROR"
              : "VALIDATION_ERROR",
      message: result.error,
    },
  });
  return true;
}

function failed(ctx: RouteCtx, action: string): Promise<boolean> {
  return audit(ctx, action, "failed");
}

function audit(ctx: RouteCtx, action: string, outcome: "success" | "failed"): Promise<boolean> {
  return writeRouteAudit(ctx, {
    action: `integration:github-ingress:${action}`,
    resourceType: "integration",
    resourceId: "github-ingress",
    outcome,
  });
}
