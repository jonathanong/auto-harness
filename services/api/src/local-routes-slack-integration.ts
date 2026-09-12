import type { SlackConfigInput, SlackSettingsPatch } from "./control-plane-slack.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";

const SLACK_PATH = "/api/v1/integrations/slack";

/** Admin authorization occurs before this handler; none of the secret body is audited or logged. */
export async function handleSlackIntegrationRoutes(ctx: RouteCtx): Promise<boolean> {
  if (ctx.url.pathname !== SLACK_PATH) return false;
  if (ctx.method === "GET") {
    try {
      const integration = await ctx.plane.getSlackIntegrationDurable();
      if (!integration) {
        send(ctx.res, 404, {
          error: { code: "NOT_FOUND", message: "Slack integration not found" },
        });
      } else {
        send(ctx.res, 200, integration);
      }
    } catch {
      sendInternalError(ctx.res);
    }
    return true;
  }
  if (
    ctx.method !== "POST" &&
    ctx.method !== "PUT" &&
    ctx.method !== "PATCH" &&
    ctx.method !== "DELETE"
  )
    return false;

  const action =
    ctx.method === "POST"
      ? "integration:slack:create"
      : ctx.method === "PUT"
        ? "integration:slack:update"
        : ctx.method === "PATCH"
          ? "integration:slack:patch"
          : "integration:slack:delete";
  if (ctx.method === "DELETE") return deleteIntegration(ctx, action);

  let input: SlackConfigInput | SlackSettingsPatch;
  try {
    input =
      ctx.method === "PATCH"
        ? parseSlackPatch(await readJson(ctx.req))
        : parseSlackConfig(await readJson(ctx.req));
  } catch (error) {
    if (!(await audit(ctx, action, "failed"))) return true;
    send(ctx.res, 400, {
      error: {
        code: "VALIDATION_ERROR",
        message: error instanceof Error ? error.message : "invalid Slack configuration",
      },
    });
    return true;
  }
  try {
    const result =
      ctx.method === "POST"
        ? await ctx.plane.createSlackIntegrationDurable(input as SlackConfigInput)
        : ctx.method === "PUT"
          ? await ctx.plane.updateSlackIntegrationDurable(input as SlackConfigInput)
          : await ctx.plane.patchSlackIntegrationDurable(input as SlackSettingsPatch);
    if (!result.ok) {
      if (!(await audit(ctx, action, "failed"))) return true;
      if (result.unavailable) return respondInternal(ctx);
      const status = result.conflict
        ? 409
        : result.error === "Slack integration not found"
          ? 404
          : 400;
      send(ctx.res, status, {
        error: {
          code: status === 409 ? "CONFLICT" : status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR",
          message: result.error,
        },
      });
      return true;
    }
    if (!(await audit(ctx, action, "success"))) return true;
    send(ctx.res, ctx.method === "POST" ? 201 : 200, result.integration);
  } catch {
    if (!(await audit(ctx, action, "failed"))) return true;
    respondInternal(ctx);
  }
  return true;
}

function parseSlackPatch(value: unknown): SlackSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Slack settings must be an object");
  const body = value as Record<string, unknown>;
  const allowed = new Set(["defaultChannel", "enabled", "expectedVersion", "notifications"]);
  if (Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.has(key))) {
    throw new Error("Slack settings contain an unsupported field");
  }
  if (body.defaultChannel !== undefined && typeof body.defaultChannel !== "string")
    throw new Error("defaultChannel must be a string");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    throw new Error("enabled must be a boolean");
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)
    throw new Error("expectedVersion must be a positive integer");
  if (
    body.notifications !== undefined &&
    (!body.notifications ||
      typeof body.notifications !== "object" ||
      Array.isArray(body.notifications))
  ) {
    throw new Error("notifications must be an object");
  }
  const patch: SlackSettingsPatch = { expectedVersion: body.expectedVersion as number };
  if (body.defaultChannel !== undefined) patch.defaultChannel = body.defaultChannel as string;
  if (body.enabled !== undefined) patch.enabled = body.enabled as boolean;
  if (body.notifications !== undefined)
    patch.notifications = body.notifications as Partial<
      import("@auto-harness/shared").SlackNotifications
    >;
  return patch;
}

async function deleteIntegration(ctx: RouteCtx, action: string): Promise<boolean> {
  try {
    const result = await ctx.plane.deleteSlackIntegrationDurable();
    if (!result.ok) {
      if (!(await audit(ctx, action, "failed"))) return true;
      send(ctx.res, result.conflict ? 409 : 404, {
        error: {
          code: result.conflict ? "CONFLICT" : "NOT_FOUND",
          message: result.error,
        },
      });
      return true;
    }
    if (!(await audit(ctx, action, "success"))) return true;
    send(ctx.res, 204, null);
  } catch {
    if (!(await audit(ctx, action, "failed"))) return true;
    respondInternal(ctx);
  }
  return true;
}

function respondInternal(ctx: RouteCtx): boolean {
  sendInternalError(ctx.res);
  return true;
}

function audit(ctx: RouteCtx, action: string, outcome: "success" | "failed"): Promise<boolean> {
  return writeRouteAudit(ctx, {
    action,
    resourceType: "integration",
    resourceId: "slack",
    outcome,
  });
}

function parseSlackConfig(value: unknown): SlackConfigInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Slack configuration must be an object");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "botToken",
    "defaultChannel",
    "enabled",
    "signingSecret",
    "notifications",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new Error("Slack configuration contains an unsupported field");
  }
  if (typeof body.botToken !== "string") throw new Error("botToken is required");
  if (typeof body.defaultChannel !== "string") throw new Error("defaultChannel is required");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (body.signingSecret !== undefined && typeof body.signingSecret !== "string") {
    throw new Error("signingSecret must be a string");
  }
  let notifications: SlackConfigInput["notifications"];
  if (body.notifications !== undefined) {
    if (
      !body.notifications ||
      typeof body.notifications !== "object" ||
      Array.isArray(body.notifications)
    ) {
      throw new Error("notifications must be an object");
    }
    notifications = body.notifications as SlackConfigInput["notifications"];
  }
  return {
    botToken: body.botToken,
    defaultChannel: body.defaultChannel,
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.signingSecret !== undefined ? { signingSecret: body.signingSecret } : {}),
    ...(notifications ? { notifications } : {}),
  };
}
