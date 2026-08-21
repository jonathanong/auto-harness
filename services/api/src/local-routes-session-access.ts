import { may, mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import { send, type RouteCtx } from "./local-http.ts";

export function canAccessSession(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

/** Host-bound credentials may only see or mutate work assigned to their host. */
export function canAccessSessionHost(ctx: RouteCtx, hostId: string | null | undefined): boolean {
  return mayAccessHost(ctx.principal, hostId);
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
  if (ctx.principal?.boundHostId) return false;
  return !ctx.principal || may(ctx.principal, "sessions:write");
}

export function canCancelSession(
  ctx: RouteCtx,
  session: { hostId?: string | null; metadata?: Record<string, unknown> },
): boolean {
  if (!canAccessSessionHost(ctx, session.hostId)) return false;
  if (!ctx.principal) return true;
  if (may(ctx.principal, "sessions:cancel-any")) return true;
  return may(ctx.principal, "sessions:write") && session.metadata?.createdBy === ctx.principal.id;
}
