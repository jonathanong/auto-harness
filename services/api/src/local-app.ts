/* eslint-disable max-lines -- login, logout, and actor rate-limit paths share one handler. */
import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthService } from "./auth.ts";
import { auditActor } from "./audit.ts";
import { authorize } from "./auth-policy.ts";
import { ControlPlane } from "./control-plane.ts";
import { applyLocalCors } from "./local-cors.ts";
import { resolvePublicBaseUrl, type LocalServerOptions, send } from "./local-http.ts";
import { handleAuditLogRoutes } from "./local-routes-audit-logs.ts";
import { handleAuthRoutes } from "./local-routes-auth.ts";
import { handleCommandRoutes } from "./local-routes-commands.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { handleHostSchedulerRoutes } from "./local-routes-host-scheduler.ts";
import { handleProviderAccountRoutes } from "./local-routes-provider-accounts.ts";
import { handleProviderRoutes } from "./local-routes-providers.ts";
import { handleRepositoryRoutes, handleScheduleRoutes } from "./local-routes-repos-schedules.ts";
import { handleSessionRoutes } from "./local-routes-sessions.ts";
import { handleSessionDrainRoutes } from "./local-routes-session-drains.ts";
import { handleSessionTargetRoutes } from "./local-routes-session-targets.ts";
import { handleUsageRoutes } from "./local-routes-usage.ts";
import { handleSlackIntegrationRoutes } from "./local-routes-slack-integration.ts";
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
  const trustProxy = options.trustProxy ?? process.env.HARNESS_TRUST_PROXY === "true";
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (applyLocalCors(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const ctx: import("./local-http.ts").RouteCtx = { plane, req, res, url, method };
    if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
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
    const basicGuess = authorization.startsWith("Basic ") && !hasSessionCookie(req.headers?.cookie);
    if (auth.mode === "required") {
      // Password guesses must consume the spray budget before bcrypt.
      if (basicGuess && (await enforceRateLimit(loginLimit))) return;
      const principal = await auth.authenticate(req);
      if (!principal) {
        if (!basicGuess && (await enforceRateLimit(loginLimit))) return;
        return auditAuthFailure(ctx, "auth:authenticate", 401, "authentication required");
      }
      ctx.principal = principal;
      if (!selfServiceAuthRoute && !logoutRoute && !authorize(principal, method, url.pathname)) {
        const deniedBucket = classifyRateLimitBucket(method, url.pathname);
        if (
          deniedBucket &&
          (await enforceRateLimit({
            ...loginLimit,
            principal,
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
    if (bucket) {
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
    if (await handleScheduleRoutes(ctx)) return;
    if (await handleHostSchedulerRoutes(ctx)) return;
    if (await handleHostInventoryRoutes(ctx)) return;
    if (await handleProviderRoutes(ctx)) return;
    if (await handleProviderAccountRoutes(ctx)) return;
    if (await handleCommandRoutes(ctx)) return;
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
