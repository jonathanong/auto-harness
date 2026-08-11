import { mayAccessRepository } from "./auth-policy.ts";
import { send, type RouteCtx } from "./local-http.ts";

export function canAccessSession(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

export function sendSessionForbidden(res: RouteCtx["res"]): void {
  send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
}

export function canCancelSession(
  ctx: RouteCtx,
  session: { metadata?: Record<string, unknown> },
): boolean {
  return (
    !ctx.principal ||
    ctx.principal.role === "admin" ||
    session.metadata?.createdBy === ctx.principal.id
  );
}
