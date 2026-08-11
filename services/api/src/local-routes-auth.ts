import { type Principal } from "./auth.ts";
import { auditActor } from "./audit.ts";
import { readJson, send, sendInternalError } from "./local-http.ts";
import {
  handleSelfServiceAuthRoutes,
  type SelfServiceAuthRouteContext,
} from "./local-routes-auth-self-service.ts";
import { handleAccountRoutes } from "./local-routes-auth-accounts.ts";

type AuthRouteContext = SelfServiceAuthRouteContext;

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
    let basic: Awaited<ReturnType<typeof auth.authenticate>>;
    try {
      basic = await auth.authenticate(req);
    } catch {
      sendInternalError(res);
      return true;
    }
    let body: Record<string, unknown> | null = null;
    if (!basic) {
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
    }
    try {
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
  if (await handleSelfServiceAuthRoutes(ctx)) return true;
  return handleAccountRoutes(ctx);
}
