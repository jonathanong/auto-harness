import { mayAccessRepository, may } from "./auth-policy.ts";
import {
  readJsonBodyWithAudit,
  commitMutationAudit,
  sendRouteError,
} from "./local-audited-route.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { sendSessionForbidden } from "./local-routes-session-access.ts";
import { InvalidListPageQueryError, parseListPageQuery } from "./control-plane-id-page.ts";

function parentIdFor(ctx: RouteCtx): string | undefined {
  return /^\/api\/v1\/sessions\/([^/]+)\/children$/.exec(ctx.url.pathname)?.[1];
}

export async function handleSessionChildrenRoute(ctx: RouteCtx): Promise<boolean> {
  const parentId = parentIdFor(ctx);
  if (!parentId || (ctx.method !== "POST" && ctx.method !== "GET")) return false;
  try {
    const parent = await ctx.plane.getSessionDurable(parentId);
    if (!parent) {
      sendSessionForbidden(ctx.res);
      return true;
    }
    const sessionToken = ctx.sessionParentId === parentId;
    if (sessionToken) {
      ctx.auditActorOverride = {
        id: `session:${parentId}`,
        kind: "session",
        role: "session",
      };
    }
    if (
      !sessionToken &&
      (!mayAccessRepository(ctx.principal, parent.repositoryId) ||
        (ctx.principal &&
          (ctx.principal.boundHostId ||
            (ctx.method === "POST" && !may(ctx.principal, "sessions:spawn")))))
    ) {
      sendSessionForbidden(ctx.res);
      return true;
    }
    if (ctx.method === "GET") {
      send(
        ctx.res,
        200,
        await ctx.plane.listSessionChildrenDurable(parentId, parseListPageQuery(ctx.url)),
      );
      return true;
    }
    const parsed = await readJsonBodyWithAudit(ctx, {
      action: "session:spawn",
      resourceType: "session",
      resourceId: parentId,
      repositoryId: parent.repositoryId,
    });
    if (!parsed.ok) return true;
    const result = await ctx.plane.createSessionChildDurable(
      parentId,
      parsed.body,
      ctx.principal
        ? { principalId: ctx.principal.id }
        : ctx.sessionCredentialHash
          ? { sessionCredentialHash: ctx.sessionCredentialHash }
          : {},
    );
    if (!result.ok) {
      if (
        !(await commitMutationAudit(ctx, {
          action: result.code === "DRAINING" ? "session-drain:admission-rejected" : "session:spawn",
          resourceType: "session",
          resourceId: parentId,
          repositoryId: parent.repositoryId,
          outcome: "failed",
          ...(result.operationId ? { metadata: { operationId: result.operationId } } : {}),
        }))
      )
        return true;
      sendRouteError(
        ctx.res,
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "CONFLICT" ||
              result.code === "DRAINING" ||
              result.code === "REPOSITORY_ADMISSION_CLOSED"
            ? 409
            : 400,
        result.code ?? "VALIDATION_ERROR",
        result.error,
        result.operationId
          ? {
              operationId: result.operationId,
              statusUrl: `/api/v1/repositories/${encodeURIComponent(parent.repositoryId ?? "")}/session-drains/${encodeURIComponent(result.operationId)}`,
            }
          : undefined,
      );
      return true;
    }
    if (
      !(await commitMutationAudit(ctx, {
        action: "session:spawn",
        resourceType: "session",
        resourceId: result.session.id,
        repositoryId: result.session.repositoryId,
        metadata: { parentSessionId: parentId, created: result.created },
      }))
    )
      return true;
    await ctx.plane.enqueueAssignment();
    send(ctx.res, result.created ? 201 : 200, { ...result.session, created: result.created });
  } catch (error) {
    if (error instanceof InvalidListPageQueryError) {
      send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
    } else {
      sendInternalError(ctx.res);
    }
  }
  return true;
}
