import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { aggregateUsage } from "./usage.ts";

/** Scoped usage reporting. Cost is operator-configured micros, not billing. */
export async function handleUsageRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  if (method !== "GET") return false;
  const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)\/usage$/.exec(url.pathname);
  if (sessionMatch) {
    try {
      const session = await plane.getSessionDurable(sessionMatch[1]!);
      if (
        !session ||
        !mayAccessRepository(ctx.principal, session.repositoryId) ||
        !mayAccessHost(ctx.principal, session.hostId)
      ) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "session not found" } });
        return true;
      }
      const records = await plane.getUsageDurable(session.id);
      if (
        !(await writeRouteAudit(ctx, {
          action: "usage:read",
          resourceType: "session-usage",
          resourceId: session.id,
          repositoryId: session.repositoryId,
        }))
      )
        return true;
      send(res, 200, { sessionId: session.id, aggregate: aggregateUsage(records), items: records });
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (url.pathname !== "/api/v1/usage") return false;
  const repositoryId = url.searchParams.get("repositoryId");
  if (!repositoryId) {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "repositoryId is required" } });
    return true;
  }
  if (!mayAccessRepository(ctx.principal, repositoryId)) {
    send(res, 404, { error: { code: "NOT_FOUND", message: "usage not found" } });
    return true;
  }
  try {
    const records = (await plane.getUsageDurable()).filter(
      (record) => record.repositoryId === repositoryId,
    );
    const hostVisible = ctx.principal?.boundHostId
      ? (
          await Promise.all(
            records.map(async (record) => {
              const session = await plane.getSessionDurable(record.sessionId);
              return session && mayAccessHost(ctx.principal, session.hostId) ? record : null;
            }),
          )
        ).filter((record) => record !== null)
      : records;
    const providerId = url.searchParams.get("providerId");
    const accountId = url.searchParams.get("providerAccountId");
    const commandId = url.searchParams.get("commandId");
    const scoped = hostVisible.filter(
      (record) =>
        (!providerId || record.providerId === providerId) &&
        (!accountId || record.providerAccountId === accountId) &&
        (!commandId || record.commandId === commandId),
    );
    if (
      !(await writeRouteAudit(ctx, {
        action: "usage:read",
        resourceType: "usage-report",
        resourceId: repositoryId,
        repositoryId,
      }))
    )
      return true;
    send(res, 200, { aggregate: aggregateUsage(scoped), items: scoped });
  } catch {
    sendInternalError(res);
  }
  return true;
}
