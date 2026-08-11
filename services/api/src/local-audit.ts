import { auditActor, SYSTEM_AUDIT_ACTOR } from "./audit.ts";
import type { AuditLogInput, AuditOutcome } from "./audit-types.ts";
import { sendInternalError, type RouteCtx } from "./local-http.ts";

type RouteAudit = Omit<AuditLogInput, "actor" | "outcome"> & { outcome?: AuditOutcome };

/**
 * Route handlers call this only after deciding the specific resource and
 * outcome. It intentionally is not response middleware: a route with richer
 * context must name its action/resource rather than relying on a URL guess.
 */
export async function writeRouteAudit(ctx: RouteCtx, event: RouteAudit): Promise<boolean> {
  try {
    await ctx.plane.appendAuditLog({
      ...event,
      actor: auditActor(ctx.principal),
      outcome: event.outcome ?? "success",
    });
    return true;
  } catch {
    sendInternalError(ctx.res);
    return false;
  }
}

/** Scheduler invocations can originate from cron rather than a human request. */
export async function writeSystemAudit(
  ctx: RouteCtx,
  event: Omit<AuditLogInput, "actor" | "outcome"> & { outcome?: AuditOutcome },
): Promise<boolean> {
  try {
    await ctx.plane.appendAuditLog({
      ...event,
      actor: ctx.principal ? auditActor(ctx.principal) : SYSTEM_AUDIT_ACTOR,
      outcome: event.outcome ?? "success",
    });
    return true;
  } catch {
    sendInternalError(ctx.res);
    return false;
  }
}
