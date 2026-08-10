import { mayAccessRepository } from "./auth-policy.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";

function canAccess(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

/** Durable session collection, detail, and log-history GET routes. */
export async function handleSessionReadRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  if (method === "GET" && url.pathname === "/api/v1/sessions") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    try {
      const page = await plane.listSessionsPageDurable({
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        ...(url.searchParams.get("hostId") ? { hostId: url.searchParams.get("hostId")! } : {}),
        ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
        ...(url.searchParams.get("q") ? { q: url.searchParams.get("q")! } : {}),
        ...(url.searchParams.get("concurrencyId")
          ? { concurrencyId: url.searchParams.get("concurrencyId")! }
          : {}),
        ...(url.searchParams.get("scheduleId")
          ? { scheduleId: url.searchParams.get("scheduleId")! }
          : {}),
      });
      send(res, 200, {
        ...page,
        items: page.items.filter((session) => canAccess(ctx, session.repositoryId)),
      });
    } catch {
      sendInternalError(res);
    }
    return true;
  }

  const logsMatch = /^\/api\/v1\/sessions\/([^/]+)\/logs$/.exec(url.pathname);
  if (method === "GET" && logsMatch) {
    try {
      const session = await plane.getSessionDurable(logsMatch[1]!);
      if (session && !canAccess(ctx, session.repositoryId)) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
      } else {
        send(res, 200, { items: await plane.getLogsDurable(logsMatch[1]!) });
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }

  const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (method !== "GET" || !sessionMatch) return false;
  try {
    const session = await plane.getSessionDurable(sessionMatch[1]!);
    if (!session || !canAccess(ctx, session.repositoryId)) {
      send(res, 404, { error: { code: "NOT_FOUND", message: "session not found" } });
    } else {
      send(res, 200, session);
    }
  } catch {
    sendInternalError(res);
  }
  return true;
}
