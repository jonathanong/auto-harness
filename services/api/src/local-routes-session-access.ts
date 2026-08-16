import { mayAccessRepository } from "./auth-policy.ts";
import { send, type RouteCtx } from "./local-http.ts";

export function canAccessSession(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

export function sendSessionForbidden(res: RouteCtx["res"]): void {
  send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
}

/**
 * A host-bound credential is a VPS agent identity (auth.md "Agent binding"). An agent
 * reports on the work it was handed; it never authors new work. Without this, a stolen
 * daemon key can create a session for any repository that key may access, and the
 * scheduler — which has no notion of who authored a session — is free to place it on a
 * different host, turning one host compromise into execution across the fleet.
 *
 * Every route that brings a session into existence must consult this: direct create, the
 * clone and resume derivations, and schedule writes (a schedule mints sessions on a cron).
 * `local-routes-session-authoring.test.ts` enumerates them so a new one cannot skip it.
 */
export function canAuthorSessions(ctx: RouteCtx): boolean {
  return !ctx.principal?.boundHostId;
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
