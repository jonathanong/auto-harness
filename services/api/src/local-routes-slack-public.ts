/* eslint-disable max-lines -- OAuth state, callback, and public event ingress share one security boundary. */
import type { ServerResponse } from "node:http";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { auditActor } from "./audit.ts";
import type { AuditActor } from "./audit-types.ts";
import { writeSystemAudit } from "./local-audit.ts";
import { readRawBody, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { handleSlackEventsRoute } from "./local-routes-slack-events.ts";
import {
  deployedSlackPublicBaseUrl,
  slackCallbackUrl,
  consumeSlackOAuth,
  startSlackOAuth,
  SlackOAuthStartConflictError,
} from "./slack-oauth.ts";
import { createSlackOAuthClient } from "./slack-oauth-client.ts";
import type {
  SlackAppCredentials,
  SlackOAuthClient,
  SlackOAuthStateRecord,
} from "./slack-oauth-types.ts";

const SLACK_OAUTH_START_PATH = "/api/v1/integrations/slack/oauth/start";
const SLACK_CALLBACK_PATH = "/api/v1/integrations/slack/oauth/callback";
const SLACK_EVENTS_PATH = "/api/v1/integrations/slack/events";

export type SlackRouteDependencies = {
  credentials?: SlackAppCredentials;
  /** AWS resolves this per OAuth request; local apps intentionally use their configured origin. */
  resolvePublicBaseUrl?: () => Promise<string | undefined>;
  oauthClient?: SlackOAuthClient;
  /** Explicit attribution for the documented local auth-disabled mode only. */
  localPrincipalId?: string;
};

/** The only unauthenticated Slack routes, metered by source address before dispatch. */
export function isPublicSlackIngressRoute(method: string, pathname: string): boolean {
  return (
    (method === "GET" && pathname === SLACK_CALLBACK_PATH) ||
    (method === "POST" && pathname === SLACK_EVENTS_PATH)
  );
}

/** Routes called by Slack itself. They intentionally run before application authentication. */
export async function handlePublicSlackRoutes(
  ctx: RouteCtx,
  dependencies: SlackRouteDependencies,
): Promise<boolean> {
  if (ctx.method === "GET" && ctx.url.pathname === SLACK_CALLBACK_PATH) {
    await callback(ctx, dependencies);
    return true;
  }
  if (ctx.method === "POST" && ctx.url.pathname === SLACK_EVENTS_PATH) {
    await handleSlackEventsRoute(ctx, dependencies.credentials);
    return true;
  }
  return false;
}

/** Admin-only OAuth initiation; local-app authentication has already established ctx.principal. */
export async function handleSlackOAuthStartRoute(
  ctx: RouteCtx,
  dependencies: SlackRouteDependencies,
): Promise<boolean> {
  if (ctx.url.pathname !== SLACK_OAUTH_START_PATH || ctx.method !== "POST") return false;
  if (!dependencies.credentials) return unavailable(ctx);
  let value: unknown;
  try {
    value = JSON.parse((await readRawBody(ctx.req, 32 * 1024)).toString("utf8"));
  } catch {
    send(ctx.res, 400, {
      error: { code: "VALIDATION_ERROR", message: "invalid Slack OAuth settings" },
    });
    return true;
  }
  const input = parseStart(value);
  if (!input || (!ctx.principal && !dependencies.localPrincipalId)) {
    send(ctx.res, 400, {
      error: { code: "VALIDATION_ERROR", message: "invalid Slack OAuth settings" },
    });
    return true;
  }
  try {
    const publicBaseUrl = await oauthPublicBaseUrl(ctx, dependencies);
    if (!publicBaseUrl) return unavailable(ctx);
    const result = await startSlackOAuth(ctx.plane.state, dependencies.credentials, {
      ...input,
      principalId: ctx.principal?.id ?? dependencies.localPrincipalId!,
      actor: ctx.principal
        ? auditActor(ctx.principal)
        : { id: dependencies.localPrincipalId!, kind: "admin", role: "admin" },
      publicBaseUrl,
    });
    if (!(await audit(ctx, "integration:slack:oauth:start", "success"))) return true;
    send(ctx.res, 201, result);
  } catch (error) {
    if (!(await audit(ctx, "integration:slack:oauth:start", "failed"))) return true;
    if (error instanceof SlackOAuthStartConflictError) {
      send(ctx.res, 409, {
        error: { code: "CONFLICT", message: "Slack integration changed concurrently; retry" },
      });
      return true;
    }
    sendInternalError(ctx.res);
  }
  return true;
}

async function callback(ctx: RouteCtx, dependencies: SlackRouteDependencies): Promise<void> {
  const state = ctx.url.searchParams.get("state") ?? "";
  const code = ctx.url.searchParams.get("code") ?? "";
  if (!state) {
    const configuredPublicBaseUrl = await oauthPublicBaseUrl(ctx, dependencies);
    if (!configuredPublicBaseUrl) return void unavailable(ctx);
    return redirect(ctx.res, configuredPublicBaseUrl, "error");
  }
  let pending: SlackOAuthStateRecord | undefined;
  let publicBaseUrl: string | undefined;
  try {
    pending = (await consumeSlackOAuth(ctx.plane.state, state)) ?? undefined;
    if (!pending) {
      const configuredPublicBaseUrl = await oauthPublicBaseUrl(ctx, dependencies);
      if (!configuredPublicBaseUrl) return void unavailable(ctx);
      return redirect(ctx.res, configuredPublicBaseUrl, "error");
    }
    publicBaseUrl = pending.publicBaseUrl;
    // Slack returns only `error` and `state` when authorization is denied. Consume state before
    // redirecting so that every callback attempt remains single-use.
    if (
      !dependencies.credentials ||
      !code ||
      code.length > 4096 ||
      ctx.url.searchParams.has("error")
    ) {
      if (!(await audit(ctx, "integration:slack:oauth:callback", "failed", callbackActor(pending))))
        return;
      return redirect(ctx.res, publicBaseUrl, "error");
    }
    const client = dependencies.oauthClient ?? createSlackOAuthClient(dependencies.credentials);
    const exchange = await client.exchangeCode({
      code,
      redirectUri: slackCallbackUrl(publicBaseUrl),
    });
    let installed: Awaited<ReturnType<typeof ctx.plane.installSlackOAuthIntegrationDurable>>;
    try {
      installed = await ctx.plane.installSlackOAuthIntegrationDurable({
        expectedVersion: pending.expectedVersion,
        ...(pending.expectedInstallationId === undefined
          ? {}
          : { expectedInstallationId: pending.expectedInstallationId }),
        defaultChannel: pending.defaultChannel,
        enabled: pending.enabled,
        notifications: pending.notifications,
        exchange,
      });
    } catch (error) {
      await revokeExchangedBotToken(ctx, client, exchange.botToken);
      throw error;
    }
    if (!installed.ok) await revokeExchangedBotToken(ctx, client, exchange.botToken);
    const outcome = installed.ok ? "success" : "failed";
    if (!(await audit(ctx, "integration:slack:oauth:callback", outcome, callbackActor(pending))))
      return;
    return redirect(ctx.res, publicBaseUrl, installed.ok ? "success" : "error");
  } catch {
    if (
      !(await audit(
        ctx,
        "integration:slack:oauth:callback",
        "failed",
        pending && callbackActor(pending),
      ))
    )
      return;
    if (!publicBaseUrl) {
      publicBaseUrl = await oauthPublicBaseUrl(ctx, dependencies);
      if (!publicBaseUrl) return void unavailable(ctx);
    }
    return redirect(ctx.res, publicBaseUrl, "error");
  }
}

/** Never let cleanup obscure the durable-install outcome presented to the OAuth user. */
async function revokeExchangedBotToken(
  ctx: RouteCtx,
  client: SlackOAuthClient,
  botToken: string,
): Promise<void> {
  try {
    // A CAS loss can leave another integration owning the same long-lived token.
    // Revoke only after a fresh, definitive durable ownership check.
    if ((await ctx.plane.getSlackBotTokenOwnershipDurable(botToken)) !== "unowned") return;
    await client.revokeBotToken(botToken);
  } catch {
    // Ownership or revocation may be unavailable; the installation rejection still governs the flow.
  }
}

function callbackActor(pending: SlackOAuthStateRecord): AuditActor {
  // OAuth states created before actor snapshots existed were admin-only too.
  return pending.actor ?? { id: pending.principalId, kind: "admin", role: "admin" };
}

async function oauthPublicBaseUrl(
  ctx: RouteCtx,
  dependencies: SlackRouteDependencies,
): Promise<string | undefined> {
  if (!dependencies.resolvePublicBaseUrl) return ctx.plane.state.publicBaseUrl;
  return deployedSlackPublicBaseUrl(await dependencies.resolvePublicBaseUrl());
}

function parseStart(value: unknown): {
  expectedVersion: number | null;
  expectedInstallationId?: string | null;
  defaultChannel: string;
  enabled?: boolean;
  notifications?: Record<string, boolean>;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "expectedVersion",
          "expectedInstallationId",
          "defaultChannel",
          "enabled",
          "notifications",
        ].includes(key),
    ) ||
    typeof input.defaultChannel !== "string" ||
    !(
      /^#[a-z0-9][a-z0-9_-]{0,79}$/.test(input.defaultChannel) ||
      /^[CGD][A-Z0-9]{8,}$/.test(input.defaultChannel)
    ) ||
    (input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1)) ||
    (input.expectedInstallationId !== undefined &&
      input.expectedInstallationId !== null &&
      (typeof input.expectedInstallationId !== "string" ||
        input.expectedInstallationId.length === 0 ||
        input.expectedInstallationId.length > 256)) ||
    (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
    (input.notifications !== undefined &&
      (!input.notifications ||
        typeof input.notifications !== "object" ||
        Array.isArray(input.notifications)))
  )
    return null;
  const notifications = input.notifications as Record<string, boolean> | undefined;
  if (
    notifications &&
    (Object.keys(notifications).some((key) => !Object.hasOwn(DEFAULT_SLACK_NOTIFICATIONS, key)) ||
      Object.values(notifications).some((setting) => typeof setting !== "boolean"))
  )
    return null;
  return {
    expectedVersion: (input.expectedVersion as number | null | undefined) ?? null,
    ...(input.expectedInstallationId === undefined
      ? {}
      : { expectedInstallationId: input.expectedInstallationId as string | null }),
    defaultChannel: input.defaultChannel,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
    ...(notifications ? { notifications } : {}),
  };
}

function redirect(res: ServerResponse, publicBaseUrl: string, result: "success" | "error"): void {
  const location = new URL(`/settings?slackOAuth=${result}`, publicBaseUrl).toString();
  res.writeHead(302, { location });
  res.end();
}

function unavailable(ctx: RouteCtx): boolean {
  send(ctx.res, 503, { error: { code: "UNAVAILABLE", message: "Slack OAuth is not configured" } });
  return true;
}

async function audit(
  ctx: RouteCtx,
  action: string,
  outcome: "success" | "failed",
  actor?: AuditActor,
): Promise<boolean> {
  if (actor) {
    try {
      await ctx.plane.appendAuditLog({
        actor,
        action,
        resourceType: "integration",
        resourceId: "slack",
        outcome,
      });
      return true;
    } catch {
      sendInternalError(ctx.res);
      return false;
    }
  }
  return writeSystemAudit(ctx, {
    action,
    resourceType: "integration",
    resourceId: "slack",
    outcome,
  });
}
