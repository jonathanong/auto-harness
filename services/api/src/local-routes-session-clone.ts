/* eslint-disable max-lines */
import { mayAccessRepository } from "./auth-policy.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import {
  canAccessSessionHost,
  canAuthorSessions,
  sendSessionForbidden,
} from "./local-routes-session-access.ts";

const CLONE_BODY_FIELDS = new Set(["prompt", "timeout", "priority"]);

function parseCloneBody(
  body: unknown,
):
  | { ok: true; prompt?: string; timeout?: number; priority?: number }
  | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "clone body must be an object" };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CLONE_BODY_FIELDS.has(key))) {
    return { ok: false, error: "invalid clone overrides" };
  }
  if (record.prompt !== undefined && (typeof record.prompt !== "string" || !record.prompt)) {
    return { ok: false, error: "prompt must be a non-empty string" };
  }
  if (
    record.timeout !== undefined &&
    (typeof record.timeout !== "number" || !Number.isFinite(record.timeout) || record.timeout <= 0)
  ) {
    return { ok: false, error: "timeout must be a positive number of seconds" };
  }
  if (
    record.priority !== undefined &&
    (typeof record.priority !== "number" || !Number.isFinite(record.priority))
  ) {
    return { ok: false, error: "priority must be a number" };
  }
  if (record.priority !== undefined && !Number.isInteger(record.priority)) {
    return { ok: false, error: "priority must be an integer" };
  }
  return {
    ok: true,
    ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
    ...(typeof record.timeout === "number" ? { timeout: record.timeout } : {}),
    ...(typeof record.priority === "number" ? { priority: record.priority } : {}),
  };
}

async function respondAfterCloneAudit(
  ctx: RouteCtx,
  event: Parameters<typeof writeRouteAudit>[1],
  respond: () => void,
): Promise<boolean> {
  if (!(await writeRouteAudit(ctx, event))) return true;
  respond();
  return true;
}

export async function handleSessionCloneRoute(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;
  const match = /^\/api\/v1\/sessions\/([^/]+)\/clone$/.exec(url.pathname);
  if (method !== "POST" || !match) return false;
  const sourceId = match[1]!;
  if (!canAuthorSessions(ctx)) {
    return respondAfterCloneAudit(
      ctx,
      {
        action: "session:clone",
        resourceType: "session",
        resourceId: sourceId,
        outcome: "denied",
      },
      () => sendSessionForbidden(res),
    );
  }
  let source: Awaited<ReturnType<typeof plane.getSessionDurable>>;
  try {
    source = await plane.getSessionDurable(sourceId);
  } catch {
    return respondAfterCloneAudit(
      ctx,
      {
        action: "session:clone",
        resourceType: "session",
        resourceId: sourceId,
        outcome: "failed",
      },
      () => sendInternalError(res),
    );
  }
  if (!source) {
    return respondAfterCloneAudit(
      ctx,
      {
        action: "session:clone",
        resourceType: "session",
        resourceId: sourceId,
        outcome: "failed",
      },
      () => send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } }),
    );
  }
  if (
    (ctx.principal && !mayAccessRepository(ctx.principal, source.repositoryId)) ||
    !canAccessSessionHost(ctx, source.hostId)
  ) {
    return respondAfterCloneAudit(
      ctx,
      {
        action: "session:clone",
        resourceType: "session",
        resourceId: sourceId,
        repositoryId: source.repositoryId,
        outcome: "denied",
      },
      () => send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } }),
    );
  }

  let parsed: Awaited<ReturnType<typeof parseCloneBody>>;
  try {
    parsed = parseCloneBody(await readJson(req));
  } catch {
    return respondAfterCloneAudit(
      ctx,
      {
        action: "session:clone",
        resourceType: "session",
        resourceId: sourceId,
        repositoryId: source.repositoryId,
        outcome: "failed",
      },
      () => send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } }),
    );
  }
  if (!parsed.ok) {
    return respondAfterCloneAudit(
      ctx,
      {
        action: "session:clone",
        resourceType: "session",
        resourceId: sourceId,
        repositoryId: source.repositoryId,
        outcome: "failed",
      },
      () => send(res, 400, { error: { code: "VALIDATION_ERROR", message: parsed.error } }),
    );
  }

  try {
    const result = await plane.cloneSessionDurable(sourceId, {
      ...(parsed.prompt !== undefined ? { prompt: parsed.prompt } : {}),
      ...(parsed.timeout !== undefined ? { timeout: parsed.timeout } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
      ...(ctx.principal ? { createdBy: ctx.principal.id } : {}),
    });
    if (!result.ok) {
      return respondAfterCloneAudit(
        ctx,
        {
          action: result.code === "DRAINING" ? "session-drain:admission-rejected" : "session:clone",
          resourceType: "session",
          resourceId: sourceId,
          repositoryId: source.repositoryId,
          outcome: "failed",
          ...(result.operationId ? { metadata: { operationId: result.operationId } } : {}),
        },
        () =>
          send(
            res,
            result.code === "CONFLICT" ||
              result.code === "REPOSITORY_ADMISSION_CLOSED" ||
              result.code === "DRAINING"
              ? 409
              : 400,
            {
              error: {
                code: result.code ?? "CLONE_ERROR",
                message: result.error,
                ...(result.operationId
                  ? {
                      operationId: result.operationId,
                      statusUrl: `/api/v1/repositories/${encodeURIComponent(source.repositoryId)}/session-drains/${encodeURIComponent(result.operationId)}`,
                    }
                  : {}),
              },
            },
          ),
      );
    }
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:clone",
        resourceType: "session",
        resourceId: result.session.id,
        repositoryId: result.session.repositoryId,
        metadata: { sourceId },
      }))
    )
      return true;
    await plane.requestAssignment();
    send(res, 201, { ...result.session, created: true });
    return true;
  } catch {
    return respondAfterCloneAudit(
      ctx,
      {
        action: "session:clone",
        resourceType: "session",
        resourceId: sourceId,
        repositoryId: source.repositoryId,
        outcome: "failed",
      },
      () => sendInternalError(res),
    );
  }
}
