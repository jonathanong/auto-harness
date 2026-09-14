import {
  isSessionLogUploadMode,
  thrownMessage,
  type SessionLogSettings,
} from "@auto-harness/shared";

import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";

const PATH = "/api/v1/session-log-settings";
const ALLOWED = new Set([
  "uploadMode",
  "batchMaxKb",
  "batchMaxLines",
  "batchMaxWaitMs",
  "controlPlanePollMs",
  "version",
]);

export async function handleSessionLogSettingsRoutes(ctx: RouteCtx): Promise<boolean> {
  if (ctx.url.pathname !== PATH) return false;
  if (ctx.method === "GET") {
    try {
      send(ctx.res, 200, await ctx.plane.getSessionLogSettings());
    } catch {
      sendInternalError(ctx.res);
    }
    return true;
  }
  if (ctx.method !== "PUT") return false;
  let input: Partial<SessionLogSettings> & { version: number };
  try {
    input = parseBody(await readJson(ctx.req));
  } catch (error) {
    if (await audit(ctx, "failed")) {
      send(ctx.res, 400, {
        error: {
          code: "VALIDATION_ERROR",
          message: thrownMessage(error),
        },
      });
    }
    return true;
  }
  try {
    const result = await ctx.plane.putSessionLogSettings(input);
    if (!result.ok) {
      if (await audit(ctx, "failed")) {
        send(ctx.res, result.conflict ? 409 : 400, {
          error: {
            code: result.conflict ? "CONFLICT" : "VALIDATION_ERROR",
            message: result.error,
          },
        });
      }
      return true;
    }
    if (await audit(ctx, "success")) send(ctx.res, 200, result.settings);
  } catch {
    if (await audit(ctx, "failed")) sendInternalError(ctx.res);
  }
  return true;
}

function parseBody(value: unknown): Partial<SessionLogSettings> & { version: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be an object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !ALLOWED.has(key))) {
    throw new Error("configuration contains an unsupported field");
  }
  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 0) {
    throw new Error("version must contain the observed non-negative integer version");
  }
  if (body.uploadMode !== undefined && !isSessionLogUploadMode(body.uploadMode)) {
    throw new Error("uploadMode must be off, subscribed, or always");
  }
  for (const key of [
    "batchMaxKb",
    "batchMaxLines",
    "batchMaxWaitMs",
    "controlPlanePollMs",
  ] as const) {
    if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isFinite(body[key]))) {
      throw new Error(`${key} must be a number`);
    }
  }
  return {
    version: body.version,
    ...(body.uploadMode !== undefined ? { uploadMode: body.uploadMode } : {}),
    ...(typeof body.batchMaxKb === "number" ? { batchMaxKb: body.batchMaxKb } : {}),
    ...(typeof body.batchMaxLines === "number" ? { batchMaxLines: body.batchMaxLines } : {}),
    ...(typeof body.batchMaxWaitMs === "number" ? { batchMaxWaitMs: body.batchMaxWaitMs } : {}),
    ...(typeof body.controlPlanePollMs === "number"
      ? { controlPlanePollMs: body.controlPlanePollMs }
      : {}),
  };
}

function audit(ctx: RouteCtx, outcome: "success" | "failed"): Promise<boolean> {
  return writeRouteAudit(ctx, {
    action: "session-log-settings:update",
    resourceType: "session-log-settings",
    resourceId: "session-log-settings",
    outcome,
  });
}
