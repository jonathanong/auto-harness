import { auditActor, SYSTEM_AUDIT_ACTOR } from "./audit.ts";
import type { AuditLogInput, AuditOutcome } from "./audit-types.ts";
import { sendInternalError, type RouteCtx } from "./local-http.ts";

export type RouteAudit = Omit<AuditLogInput, "actor" | "outcome"> & { outcome?: AuditOutcome };

/**
 * Route handlers call this only after deciding the specific resource and
 * outcome. It intentionally is not response middleware: a route with richer
 * context must name its action/resource rather than relying on a URL guess.
 */
export async function writeRouteAudit(ctx: RouteCtx, event: RouteAudit): Promise<boolean> {
  try {
    await ctx.plane.appendAuditLog({
      ...event,
      actor: ctx.auditActorOverride ?? auditActor(ctx.principal),
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

/**
 * Terminal acknowledgements must not become retryable because their diagnostic
 * audit append failed or stalled. Callers detach this promise only after the
 * durable operation has committed or the event has been intentionally ignored;
 * this function consumes failures so detached work cannot cause an unhandled rejection.
 */
export async function writeSystemAuditBestEffort(
  ctx: RouteCtx,
  event: Omit<AuditLogInput, "actor" | "outcome"> & { outcome?: AuditOutcome },
): Promise<void> {
  try {
    await ctx.plane.appendAuditLog({
      ...event,
      actor: ctx.principal ? auditActor(ctx.principal) : SYSTEM_AUDIT_ACTOR,
      outcome: event.outcome ?? "success",
    });
  } catch {
    // The durable ingress result is already committed; an audit outage must
    // not make Slack retry the event and create duplicate delivery pressure.
  }
}
