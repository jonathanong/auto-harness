import type { SessionDrainRecord } from "./db/plane-storage.ts";
import { auditActor } from "./audit.ts";
import { mayAccessRepository } from "./auth-policy.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { canAuthorSessions } from "./local-routes-session-access.ts";

function statusUrl(repositoryId: string, operationId: string): string {
  return `/api/v1/repositories/${encodeURIComponent(repositoryId)}/session-drains/${encodeURIComponent(operationId)}`;
}

function publicDrain(drain: SessionDrainRecord) {
  return {
    operationId: drain.operationId,
    repositoryId: drain.repositoryId,
    status: drain.status,
    statusUrl: statusUrl(drain.repositoryId, drain.operationId),
    requestedAt: drain.requestedAt,
    updatedAt: drain.updatedAt,
    deadlineAt: drain.deadlineAt,
    queuedCount: drain.queuedCount,
    runningCount: drain.runningCount,
    cancelledCount: drain.cancelledCount,
    ...(drain.completedAt ? { completedAt: drain.completedAt } : {}),
    ...(drain.releasedAt ? { releasedAt: drain.releasedAt } : {}),
    ...(drain.failureCode ? { failureCode: drain.failureCode } : {}),
  };
}

export async function handleSessionDrainRoutes(ctx: RouteCtx): Promise<boolean> {
  const createMatch = /^\/api\/v1\/repositories\/([^/]+)\/session-drains$/.exec(ctx.url.pathname);
  const operationMatch =
    /^\/api\/v1\/repositories\/([^/]+)\/session-drains\/([^/]+)(\/release)?$/.exec(
      ctx.url.pathname,
    );
  if (!createMatch && !operationMatch) return false;

  const repositoryId = decodeURIComponent((createMatch ?? operationMatch)![1]!);
  if (
    !ctx.principal ||
    !canAuthorSessions(ctx) ||
    !mayAccessRepository(ctx.principal, repositoryId)
  ) {
    send(ctx.res, ctx.principal ? 404 : 401, {
      error: {
        code: ctx.principal ? "NOT_FOUND" : "UNAUTHORIZED",
        message: ctx.principal ? "repository not found" : "authentication required",
      },
    });
    return true;
  }

  try {
    if (createMatch && ctx.method === "POST") {
      const rawIdempotencyKey = ctx.req.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(rawIdempotencyKey)
        ? rawIdempotencyKey[0]
        : rawIdempotencyKey;
      const result = await ctx.plane.createSessionDrainDurable(
        repositoryId,
        ctx.principal.id,
        idempotencyKey,
        auditActor(ctx.principal),
      );
      if ("error" in result) {
        send(
          ctx.res,
          result.code === "NOT_FOUND" ? 404 : result.code === "VALIDATION_ERROR" ? 400 : 409,
          {
            error: { code: result.code, message: result.error },
          },
        );
        return true;
      }
      send(ctx.res, 202, publicDrain(result.drain));
      return true;
    }

    if (!operationMatch) return false;
    const operationId = decodeURIComponent(operationMatch[2]!);
    if (!operationMatch[3] && ctx.method === "GET") {
      const drain = await ctx.plane.getSessionDrainDurable(
        repositoryId,
        ctx.principal.id,
        operationId,
        auditActor(ctx.principal),
      );
      if (!drain) {
        send(ctx.res, 404, { error: { code: "NOT_FOUND", message: "session drain not found" } });
        return true;
      }
      send(ctx.res, 200, publicDrain(drain));
      return true;
    }
    if (operationMatch[3] && ctx.method === "POST") {
      const drain = await ctx.plane.releaseSessionDrainDurable(
        repositoryId,
        ctx.principal.id,
        operationId,
      );
      if (!drain) {
        send(ctx.res, 409, {
          error: {
            code: "DRAIN_NOT_QUIESCENT",
            message: "only a terminal session drain can be released",
          },
        });
        return true;
      }
      send(ctx.res, 200, publicDrain(drain));
      return true;
    }
  } catch {
    sendInternalError(ctx.res);
    return true;
  }
  return false;
}
