/* eslint-disable max-lines -- login, logout, and actor rate-limit paths share one handler. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import { AuthService } from "./auth.ts";
import { auditActor } from "./audit.ts";
import { authorize } from "./auth-policy.ts";
import { ControlPlane } from "./control-plane.ts";
import { applyLocalCors } from "./local-cors.ts";
import { resolvePublicBaseUrl, type LocalServerOptions, send } from "./local-http.ts";
import { handleAuditLogRoutes } from "./local-routes-audit-logs.ts";
import { handleAuthRoutes } from "./local-routes-auth.ts";
import { handleCommandRoutes } from "./local-routes-commands.ts";
import { handleHostExecConfigRoutes } from "./local-routes-host-exec-config.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { handleHostUpdateConfigRoutes } from "./local-routes-host-update-config.ts";
import { handleHostSchedulerRoutes } from "./local-routes-host-scheduler.ts";
import { handleProviderAccountRoutes } from "./local-routes-provider-accounts.ts";
import { handleProviderRoutes } from "./local-routes-providers.ts";
import { handleRepositoryRoutes, handleScheduleRoutes } from "./local-routes-repos-schedules.ts";
import { handleSessionRoutes } from "./local-routes-sessions.ts";
import { handleSessionDrainRoutes } from "./local-routes-session-drains.ts";
import { handleSessionTargetRoutes } from "./local-routes-session-targets.ts";
import { handleUsageRoutes } from "./local-routes-usage.ts";
import { handleWorkspacePoolRoutes } from "./local-routes-workspace-pools.ts";
import { handleSlackIntegrationRoutes } from "./local-routes-slack-integration.ts";
import {
  handlePublicSlackRoutes,
  handleSlackOAuthStartRoute,
  isPublicSlackIngressRoute,
} from "./local-routes-slack-public.ts";
import { parseSlackAppCredentials } from "./slack-app-config.ts";
import { createSlackOAuthClient } from "./slack-oauth-client.ts";
import { MemorySessionStore } from "./memory-store.ts";
import { enforceRateLimit } from "./local-rate-limit.ts";
import {
  classifyRateLimitBucket,
  MemoryRateLimiter,
  mergeRateLimitConfig,
  rateLimitConfigFromEnv,
  type RateLimitConfig,
} from "./rate-limit.ts";

export function createLocalApp(options: LocalServerOptions = {}): {
  store: MemorySessionStore;
  plane: ControlPlane;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const auth = options.authService ?? new AuthService({ mode: options.authMode });
  const plane =
    options.plane ??
    options.store?.plane ??
    new ControlPlane({ publicBaseUrl: resolvePublicBaseUrl(options.publicBaseUrl) });
  const store = options.store ?? new MemorySessionStore({ plane });
  const envRateLimitConfig = rateLimitConfigFromEnv();
  const config: RateLimitConfig = mergeRateLimitConfig({
    ...envRateLimitConfig,
    ...options.rateLimitConfig,
    limits: { ...envRateLimitConfig.limits, ...options.rateLimitConfig?.limits },
  });
  const memoryLimiter = new MemoryRateLimiter(config.maxEntries);
  const now = options.rateLimitNow ?? (() => Date.now());
  const configuredSlackApp =
    options.slackAppCredentials ?? parseSlackAppCredentials(process.env.HARNESS_SLACK_APP);
  const slackOAuthClient =
    options.slackOAuthClient ??
    plane.state.slackOAuthClient ??
    (configuredSlackApp ? createSlackOAuthClient(configuredSlackApp) : undefined);
  plane.state.slackOAuthClient = slackOAuthClient;
  if (options.slackIdentityClient) plane.state.slackIdentityClient = options.slackIdentityClient;
  plane.state.slackInboundEnabled = Boolean(configuredSlackApp);
  const slackRoutes = {
    ...(configuredSlackApp ? { credentials: configuredSlackApp } : {}),
    ...(options.resolveSlackOAuthPublicBaseUrl
      ? { resolvePublicBaseUrl: options.resolveSlackOAuthPublicBaseUrl }
      : {}),
    ...(slackOAuthClient ? { oauthClient: slackOAuthClient } : {}),
    ...(auth.mode === "disabled" ? { localPrincipalId: "local:disabled-auth" } : {}),
  };
  const trustProxy = options.trustProxy ?? process.env.HARNESS_TRUST_PROXY === "true";
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (applyLocalCors(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const ctx: import("./local-http.ts").RouteCtx = { plane, req, res, url, method };
    const childRoute = /^\/api\/v1\/sessions\/([^/]+)\/children$/.exec(url.pathname);
    if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    if (
      isPublicSlackIngressRoute(method, url.pathname) &&
      (await enforceRateLimit({
        config,
        memoryLimiter,
        now,
        options,
        plane,
        req,
        res,
        method,
        pathname: url.pathname,
        bucket: "publicIngress",
        trustProxy,
        auditDenied: false,
      }))
    )
      return;
    if (await handlePublicSlackRoutes(ctx, slackRoutes)) return;
    const authRoute = url.pathname.startsWith("/api/v1/auth/");
    const loginRoute = method === "POST" && url.pathname === "/api/v1/auth/login";
    const logoutRoute = method === "POST" && url.pathname === "/api/v1/auth/logout";
    const selfServiceAuthRoute =
      url.pathname === "/api/v1/auth/me" ||
      url.pathname === "/api/v1/auth/password" ||
      url.pathname === "/api/v1/auth/viewer-ticket";
    const loginLimit = {
      config,
      memoryLimiter,
      now,
      options,
      plane,
      req,
      res,
      method,
      pathname: url.pathname,
      principal: undefined,
      bucket: "login" as const,
      trustProxy,
    };
    if (loginRoute) {
      if (await enforceRateLimit(loginLimit)) return;
      if (await handleAuthRoutes({ auth, ...ctx })) return;
    }
    const authorizationHeader = req.headers?.authorization;
    const authorization = typeof authorizationHeader === "string" ? authorizationHeader : "";
    const sessionKey = authorization.startsWith("Bearer hns_session_")
      ? authorization.slice("Bearer ".length)
      : undefined;
    // Session credentials are not AuthService principals, so their parent lookup
    // happens before the ordinary authenticated-route limiter. Consume the route's
    // mutation budget first, keyed by the peer address, so invalid session keys cannot
    // turn arbitrary parent ids into an unauthenticated durable-read oracle. Mark the
    // route as already limited below: one request gets one normal mutation/login budget,
    // not a pre-auth token plus a second post-auth token.
    const sessionCredentialRoute = method === "POST" && Boolean(childRoute && sessionKey);
    let preAuthRouteRateLimited = false;
    if (sessionCredentialRoute) {
      if (await enforceRateLimit({ ...loginLimit, bucket: "mutation" })) return;
      preAuthRouteRateLimited = true;
    }
    // A session token is deliberately not an AuthService principal: it cannot
    // reach any route other than its own children collection.
    if (
      method === "POST" &&
      childRoute &&
      sessionKey &&
      (await plane.authenticateSessionApiKey(childRoute[1]!, sessionKey))
    ) {
      ctx.sessionParentId = childRoute[1]!;
      ctx.sessionCredentialHash = createHash("sha256").update(sessionKey).digest("hex");
    }
    const basicGuess = authorization.startsWith("Basic ") && !hasSessionCookie(req.headers?.cookie);
    if (auth.mode === "required") {
      // Password guesses must consume the spray budget before bcrypt.
      if (basicGuess && (await enforceRateLimit(loginLimit))) return;
      const principal = ctx.sessionParentId ? null : await auth.authenticate(req);
      if (!ctx.sessionParentId && !principal) {
        if (!basicGuess && !sessionCredentialRoute && (await enforceRateLimit(loginLimit))) return;
        return auditAuthFailure(ctx, "auth:authenticate", 401, "authentication required");
      }
      if (principal) ctx.principal = principal;
      if (
        !ctx.sessionParentId &&
        !selfServiceAuthRoute &&
        !logoutRoute &&
        !authorize(principal!, method, url.pathname)
      ) {
        const deniedBucket = classifyRateLimitBucket(method, url.pathname);
        if (
          deniedBucket &&
          (await enforceRateLimit({
            ...loginLimit,
            principal: principal!,
            bucket: deniedBucket,
          }))
        )
          return;
        return auditAuthFailure(ctx, "auth:authorize", 403, "insufficient role for this operation");
      }
    } else if (logoutRoute) {
      if (
        await enforceRateLimit({
          ...loginLimit,
          bucket: "mutation",
        })
      )
        return;
      if (await handleAuthRoutes({ auth, ...ctx })) return;
    } else if (selfServiceAuthRoute) {
      const principal = await auth.authenticate(req);
      if (principal) ctx.principal = principal;
    }
    const bucket = classifyRateLimitBucket(method, url.pathname);
    if (bucket && !preAuthRouteRateLimited) {
      const limited = await enforceRateLimit({
        config,
        memoryLimiter,
        now,
        options,
        plane,
        req,
        res,
        method,
        pathname: url.pathname,
        principal: ctx.principal,
        bucket,
        trustProxy,
      });
      if (limited) return;
    }
    if (authRoute && (await handleAuthRoutes({ auth, ...ctx }))) return;
    if (await handleAuditLogRoutes(ctx)) return;
    if (await handleSessionRoutes(ctx)) return;
    if (await handleSessionDrainRoutes(ctx)) return;
    if (await handleUsageRoutes(ctx)) return;
    if (await handleRepositoryRoutes(ctx)) return;
    if (await handleWorkspacePoolRoutes(ctx)) return;
    if (await handleScheduleRoutes(ctx)) return;
    if (await handleHostSchedulerRoutes(ctx)) return;
    if (await handleHostInventoryRoutes(ctx)) return;
    if (await handleHostExecConfigRoutes(ctx)) return;
    if (await handleHostUpdateConfigRoutes(ctx)) return;
    if (await handleProviderRoutes(ctx)) return;
    if (await handleProviderAccountRoutes(ctx)) return;
    if (await handleCommandRoutes(ctx)) return;
    if (await handleSlackOAuthStartRoute(ctx, slackRoutes)) return;
    if (await handleSlackIntegrationRoutes(ctx)) return;
    if (await handleSessionTargetRoutes(ctx)) return;
    send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
  };

  /**
   * Last-resort boundary. Route modules catch their own IO, but anything escaping one —
   * a malformed request URL, a throw inside CORS, rate limiting, or authentication —
   * used to reject the floated promise in local-server's createServer callback. Node
   * turns an unhandled rejection into process exit, so a single unguarded throw took the
   * whole API down and left the client socket hanging with no response.
   */
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await route(req, res);
    } catch (error) {
      // Do not log request-derived method or URL text: either can contain control characters.
      console.error("unhandled request error", error);
      if (!res.headersSent) {
        send(res, 500, {
          error: { code: "INTERNAL_ERROR", message: "internal server error" },
        });
      }
    }
  };
  return { store, plane, handler };
}

function hasSessionCookie(cookieHeader: string | string[] | undefined): boolean {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  return Boolean(
    header
      ?.split(";")
      .map((part) => part.trim())
      .some((part) => part.startsWith("auto_harness_session=")),
  );
}

async function auditAuthFailure(
  ctx: import("./local-http.ts").RouteCtx,
  action: "auth:authenticate" | "auth:authorize",
  status: 401 | 403,
  message: string,
): Promise<void> {
  try {
    await ctx.plane.appendAuditLog({
      actor: auditActor(ctx.principal),
      action,
      resourceType: "route",
      resourceId: `${ctx.method} ${ctx.url.pathname}`,
      outcome: "denied",
    });
  } catch {
    send(ctx.res, 500, {
      error: { code: "INTERNAL_ERROR", message: "unable to persist control-plane state" },
    });
    return;
  }
  send(ctx.res, status, {
    error: { code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", message },
  });
}
