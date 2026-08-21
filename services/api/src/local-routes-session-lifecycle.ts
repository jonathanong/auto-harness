import { writeRouteAudit } from "./local-audit.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { may } from "./auth-policy.ts";
import {
  canAccessSession,
  canAccessSessionHost,
  canCancelSession,
  sendSessionForbidden,
} from "./local-routes-session-access.ts";

export async function handleSessionLifecycleRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  const cancelMatch = /^\/api\/v1\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
  if (method === "POST" && cancelMatch) {
    try {
      const session = await plane.getSessionDurable(cancelMatch[1]!);
      if (
        session &&
        (!canAccessSession(ctx, session.repositoryId) ||
          !canAccessSessionHost(ctx, session.hostId) ||
          !canCancelSession(ctx, session))
      ) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "session:cancel",
            resourceType: "session",
            resourceId: cancelMatch[1]!,
            repositoryId: session.repositoryId,
            outcome: "denied",
          }))
        )
          return true;
        sendSessionForbidden(res);
        return true;
      }
      const result = await plane.cancelSessionDurable(cancelMatch[1]!);
      if (!result.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "session:cancel",
            resourceType: "session",
            resourceId: cancelMatch[1]!,
            ...(session?.repositoryId ? { repositoryId: session.repositoryId } : {}),
            outcome: "failed",
          }))
        )
          return true;
        const missing = result.error === "session not found";
        send(res, missing ? 404 : 409, {
          error: { code: missing ? "NOT_FOUND" : "CONFLICT", message: result.error },
        });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "session:cancel",
          resourceType: "session",
          resourceId: result.session.id,
          repositoryId: result.session.repositoryId,
        }))
      )
        return true;
      send(res, 200, result.session);
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: "session:cancel",
          resourceType: "session",
          resourceId: cancelMatch[1]!,
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
    }
    return true;
  }
  const archiveMatch = /^\/api\/v1\/sessions\/([^/]+)\/archive$/.exec(url.pathname);
  if (method !== "POST" || !archiveMatch) return false;
  const id = archiveMatch[1]!;
  // Resolve durably: a cache-only read makes the scope check below vanish whenever this
  // process has not seen the session, which is the normal case on a fresh worker.
  const session = await plane.getSessionDurable(id);
  if (
    !session ||
    (ctx.principal && !may(ctx.principal, "sessions:archive")) ||
    !canAccessSession(ctx, session.repositoryId) ||
    !canAccessSessionHost(ctx, session.hostId)
  ) {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:archive",
        resourceType: "session",
        resourceId: id,
        ...(session?.repositoryId ? { repositoryId: session.repositoryId } : {}),
        outcome: "denied",
      }))
    )
      return true;
    sendSessionForbidden(res);
    return true;
  }
  try {
    const archived = await plane.archiveSessionLogs(id);
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:archive",
        resourceType: "session",
        resourceId: id,
        repositoryId: session.repositoryId,
        outcome: "success",
      }))
    )
      return true;
    // Metadata only. The transcript is retrievable through the scoped logs route; echoing
    // it here would make this endpoint a second, less guarded way to read it.
    send(res, 200, {
      key: archived.key,
      contentType: archived.contentType,
      bodyBytes: Buffer.byteLength(archived.body),
    });
  } catch {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:archive",
        resourceType: "session",
        resourceId: id,
        repositoryId: session.repositoryId,
        outcome: "failed",
      }))
    )
      return true;
    sendInternalError(res);
  }
  return true;
}
