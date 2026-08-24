import {
  commitMutationAudit,
  readJsonBodyWithAudit,
  sendRouteError,
} from "./local-audited-route.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import {
  canAccessSession,
  canAuthorSessions,
  sendSessionForbidden,
} from "./local-routes-session-access.ts";

export async function handleSessionCreateRoute(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  if (method !== "POST" || url.pathname !== "/api/v1/sessions") return false;
  const parsed = await readJsonBodyWithAudit(ctx, {
    action: "session:create",
    resourceType: "session",
    resourceId: "new",
  });
  if (!parsed.ok) return true;
  const body = parsed.body;
  const sessionBody =
    body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const repositoryId =
    typeof sessionBody?.repositoryId === "string" ? sessionBody.repositoryId : undefined;
  if (!canAuthorSessions(ctx) || !canAccessSession(ctx, repositoryId)) {
    if (
      !(await commitMutationAudit(ctx, {
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
    sendRouteError(res, 400, "VALIDATION_ERROR", "metadata must be an object");
    return true;
  }
  const input = sessionBody
    ? {
        ...sessionBody,
        // Public create cannot mint scheduled sessions. webhook/ui are real
        // caller provenance; schedule is internal to the dispatcher.
        type: "prompt",
        source:
          sessionBody.source === "ui" || sessionBody.source === "webhook"
            ? sessionBody.source
            : "api",
        ...(ctx.principal
          ? {
              metadata: {
                ...(sessionBody.metadata as Record<string, unknown> | undefined),
                createdBy: ctx.principal.id,
              },
            }
          : {}),
      }
    : body;
  try {
    const result = await plane.createSessionDurable(
      input,
      ctx.principal ? { principalId: ctx.principal.id } : {},
    );
    if (!result.ok) {
      if (
        !(await commitMutationAudit(ctx, {
          action:
            result.code === "DRAINING" ? "session-drain:admission-rejected" : "session:create",
          resourceType: "session",
          resourceId: "new",
          ...(repositoryId ? { repositoryId } : {}),
          outcome: "failed",
          ...(result.operationId ? { metadata: { operationId: result.operationId } } : {}),
        }))
      )
        return true;
      send(
        res,
        result.code === "CONFLICT" ||
          result.code === "REPOSITORY_ADMISSION_CLOSED" ||
          result.code === "DRAINING"
          ? 409
          : 400,
        {
          error: {
            code: result.code ?? "VALIDATION_ERROR",
            message: result.error,
            ...(result.operationId
              ? {
                  operationId: result.operationId,
                  statusUrl: `/api/v1/repositories/${encodeURIComponent(repositoryId!)}/session-drains/${encodeURIComponent(result.operationId)}`,
                }
              : {}),
          },
        },
      );
      return true;
    }
    if (!canAccessSession(ctx, result.session.repositoryId)) {
      if (
        !(await commitMutationAudit(ctx, {
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
      !(await commitMutationAudit(ctx, {
        action: "session:create",
        resourceType: "session",
        resourceId: result.session.id,
        repositoryId: result.session.repositoryId,
        metadata: { created: result.created },
      }))
    )
      return true;
    await plane.requestAssignment();
    send(res, result.created ? 201 : 200, { ...result.session, created: result.created });
  } catch {
    if (
      !(await commitMutationAudit(ctx, {
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
