import type { IncomingMessage, ServerResponse } from "node:http";

import { type AuthService, type Principal } from "./auth.ts";
import { auditActor } from "./audit.ts";
import type { ControlPlane } from "./control-plane.ts";
import { readJson, send } from "./local-http.ts";
import { handleAccountRoutes } from "./local-routes-auth-accounts.ts";

type AuthRouteContext = {
  auth: AuthService;
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  principal?: Principal;
};

async function audit(
  ctx: AuthRouteContext,
  actor: Principal | undefined,
  action: string,
  resourceType: string,
  resourceId: string,
  outcome: "success" | "denied" | "failed",
): Promise<boolean> {
  try {
    await ctx.plane.appendAuditLog({
      actor: auditActor(actor ?? ctx.principal),
      action,
      resourceType,
      resourceId,
      outcome,
    });
    return true;
  } catch {
    send(ctx.res, 500, {
      error: { code: "INTERNAL_ERROR", message: "unable to persist control-plane state" },
    });
    return false;
  }
}

/** Login/logout and admin-only durable account-management routes. */
export async function handleAuthRoutes(ctx: AuthRouteContext): Promise<boolean> {
  const { auth, req, res, url, method } = ctx;
  if (method === "POST" && url.pathname === "/api/v1/auth/login") {
    try {
      const basic = await auth.authenticate(req);
      const body = basic ? null : ((await readJson(req)) as Record<string, unknown>);
      const principal =
        basic ??
        (typeof body?.username === "string" && typeof body.password === "string"
          ? await auth.authenticatePassword(body.username, body.password)
          : null);
      if (!principal) {
        if (!(await audit(ctx, undefined, "auth:login", "credential", "login", "denied")))
          return true;
        send(res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid credentials" } });
        return true;
      }
      if (!(await audit(ctx, principal, "auth:login", "session", principal.id, "success")))
        return true;
      auth.issueCookie(res, principal);
      send(res, 200, { principal });
    } catch {
      if (!(await audit(ctx, undefined, "auth:login", "credential", "login", "failed")))
        return true;
      send(res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid credentials" } });
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/auth/logout") {
    const principal = await auth.authenticate(req);
    if (
      !(await audit(
        ctx,
        principal ?? undefined,
        "auth:logout",
        "session",
        principal?.id ?? "anonymous",
        "success",
      ))
    )
      return true;
    auth.clearCookie(res);
    send(res, 204, null);
    return true;
  }
  return handleAccountRoutes(ctx);
}
