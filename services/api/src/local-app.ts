import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthService } from "./auth.ts";
import { auditActor } from "./audit.ts";
import { authorize } from "./auth-policy.ts";
import { ControlPlane } from "./control-plane.ts";
import { applyLocalCors } from "./local-cors.ts";
import { type LocalServerOptions, send } from "./local-http.ts";
import { handleAuditLogRoutes } from "./local-routes-audit-logs.ts";
import { handleAuthRoutes } from "./local-routes-auth.ts";
import { handleCommandRoutes } from "./local-routes-commands.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { handleHostSchedulerRoutes } from "./local-routes-host-scheduler.ts";
import { handleProviderAccountRoutes } from "./local-routes-provider-accounts.ts";
import { handleProviderRoutes } from "./local-routes-providers.ts";
import { handleRepositoryRoutes, handleScheduleRoutes } from "./local-routes-repos-schedules.ts";
import { handleSessionRoutes } from "./local-routes-sessions.ts";
import { handleSessionTargetRoutes } from "./local-routes-session-targets.ts";
import { MemorySessionStore } from "./memory-store.ts";

export function createLocalApp(options: LocalServerOptions = {}): {
  store: MemorySessionStore;
  plane: ControlPlane;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const auth = options.authService ?? new AuthService({ mode: options.authMode });
  const plane =
    options.plane ??
    options.store?.plane ??
    new ControlPlane({ publicBaseUrl: options.publicBaseUrl ?? "http://localhost:7421" });
  const store = options.store ?? new MemorySessionStore({ plane });
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (applyLocalCors(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const ctx: import("./local-http.ts").RouteCtx = { plane, req, res, url, method };
    if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    const authRoute = url.pathname.startsWith("/api/v1/auth/");
    const sessionRoute =
      url.pathname === "/api/v1/auth/login" || url.pathname === "/api/v1/auth/logout";
    if (sessionRoute && (await handleAuthRoutes({ auth, ...ctx }))) return;
    if (auth.mode === "required") {
      const principal = await auth.authenticate(req);
      if (!principal)
        return auditAuthFailure(ctx, "auth:authenticate", 401, "authentication required");
      if (!authorize(principal, method, url.pathname)) {
        ctx.principal = principal;
        return auditAuthFailure(ctx, "auth:authorize", 403, "insufficient role for this operation");
      }
      ctx.principal = principal;
    }
    if (authRoute && (await handleAuthRoutes({ auth, ...ctx }))) return;
    if (await handleAuditLogRoutes(ctx)) return;
    if (await handleSessionRoutes(ctx)) return;
    if (await handleRepositoryRoutes(ctx)) return;
    if (await handleScheduleRoutes(ctx)) return;
    if (await handleHostSchedulerRoutes(ctx)) return;
    if (await handleHostInventoryRoutes(ctx)) return;
    if (await handleProviderRoutes(ctx)) return;
    if (await handleProviderAccountRoutes(ctx)) return;
    if (await handleCommandRoutes(ctx)) return;
    if (await handleSessionTargetRoutes(ctx)) return;
    send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
  };
  return { store, plane, handler };
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
