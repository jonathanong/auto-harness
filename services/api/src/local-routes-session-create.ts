import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { canAccessSession, sendSessionForbidden } from "./local-routes-session-access.ts";

export async function handleSessionCreateRoute(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;
  if (method !== "POST" || url.pathname !== "/api/v1/sessions") return false;
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:create",
        resourceType: "session",
        resourceId: "new",
        outcome: "failed",
      }))
    )
      return true;
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
    return true;
  }
  const sessionBody =
    body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const repositoryId =
    typeof sessionBody?.repositoryId === "string" ? sessionBody.repositoryId : undefined;
  if (!canAccessSession(ctx, repositoryId)) {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:create",
        resourceType: "session",
        resourceId: "new",
        ...(repositoryId ? { repositoryId } : {}),
        outcome: "denied",
      }))
    )
      return true;
    sendSessionForbidden(res);
    return true;
  }
  if (
    ctx.principal &&
    sessionBody?.metadata !== undefined &&
    (typeof sessionBody.metadata !== "object" ||
      sessionBody.metadata === null ||
      Array.isArray(sessionBody.metadata))
  ) {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "metadata must be an object" } });
    return true;
  }
  const input =
    ctx.principal && sessionBody
      ? {
          ...sessionBody,
          metadata: {
            ...(sessionBody.metadata as Record<string, unknown> | undefined),
            createdBy: ctx.principal.id,
          },
        }
      : body;
  try {
    const result = await plane.createSessionDurable(input);
    if (!result.ok) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "session:create",
          resourceType: "session",
          resourceId: "new",
          ...(repositoryId ? { repositoryId } : {}),
          outcome: "failed",
        }))
      )
        return true;
      send(res, result.code === "CONFLICT" ? 409 : 400, {
        error: { code: result.code ?? "VALIDATION_ERROR", message: result.error },
      });
      return true;
    }
    if (!canAccessSession(ctx, result.session.repositoryId)) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "session:create",
          resourceType: "session",
          resourceId: result.session.id,
          repositoryId: result.session.repositoryId,
          outcome: "denied",
        }))
      )
        return true;
      sendSessionForbidden(res);
      return true;
    }
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:create",
        resourceType: "session",
        resourceId: result.session.id,
        repositoryId: result.session.repositoryId,
        metadata: { created: result.created },
      }))
    )
      return true;
    send(res, result.created ? 201 : 200, { ...result.session, created: result.created });
  } catch {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:create",
        resourceType: "session",
        resourceId: "new",
        outcome: "failed",
      }))
    )
      return true;
    sendInternalError(res);
  }
  return true;
}
