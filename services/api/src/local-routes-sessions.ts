import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessRepository } from "./auth-policy.ts";
import { handleSessionCloneRoute } from "./local-routes-session-clone.ts";
import { handleSessionReadRoutes } from "./local-routes-session-reads.ts";

function canAccess(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

function sendForbidden(res: RouteCtx["res"]): void {
  send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
}

function canCancel(ctx: RouteCtx, session: { metadata?: Record<string, unknown> }): boolean {
  if (!ctx.principal || ctx.principal.role === "admin") return true;
  return session.metadata?.createdBy === ctx.principal.id;
}

const RESUME_BODY_FIELDS = new Set(["prompt", "timeout", "priority"]);

function validResumeBody(body: Record<string, unknown>): boolean {
  return (
    Object.keys(body).every((key) => RESUME_BODY_FIELDS.has(key)) &&
    (body.prompt === undefined || (typeof body.prompt === "string" && body.prompt.length > 0)) &&
    (body.timeout === undefined ||
      (typeof body.timeout === "number" && Number.isFinite(body.timeout) && body.timeout > 0)) &&
    (body.priority === undefined ||
      (typeof body.priority === "number" && Number.isFinite(body.priority)))
  );
}

/** Session collection + sub-resource routes. Returns true if handled. */
export async function handleSessionRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (await handleSessionCloneRoute(ctx)) return true;

  if (method === "POST" && url.pathname === "/api/v1/sessions") {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    try {
      const record =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : undefined;
      const repositoryId =
        typeof record?.repositoryId === "string" ? record.repositoryId : undefined;
      if (!canAccess(ctx, repositoryId)) {
        sendForbidden(res);
        return true;
      }
      if (
        ctx.principal &&
        record?.metadata !== undefined &&
        (typeof record.metadata !== "object" ||
          record.metadata === null ||
          Array.isArray(record.metadata))
      ) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "metadata must be an object when set" },
        });
        return true;
      }
      const input =
        ctx.principal && record
          ? {
              ...record,
              metadata: {
                ...(record.metadata as Record<string, unknown> | undefined),
                createdBy: ctx.principal.id,
              },
            }
          : body;
      const result = await plane.createSessionDurable(input);
      if (!result.ok) {
        send(res, result.code === "CONFLICT" ? 409 : 400, {
          error: { code: result.code ?? "VALIDATION_ERROR", message: result.error },
        });
        return true;
      }
      if (!canAccess(ctx, result.session.repositoryId)) {
        sendForbidden(res);
        return true;
      }
      send(res, result.created ? 201 : 200, { ...result.session, created: result.created });
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }

  if (await handleSessionReadRoutes(ctx)) return true;

  const cancelMatch = /^\/api\/v1\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
  if (method === "POST" && cancelMatch) {
    try {
      const session = await plane.getSessionDurable(cancelMatch[1]!);
      if (session && (!canAccess(ctx, session.repositoryId) || !canCancel(ctx, session))) {
        sendForbidden(res);
        return true;
      }
      const result = await plane.cancelSessionDurable(cancelMatch[1]!);
      if (!result.ok) {
        const missing = result.error === "session not found";
        send(res, missing ? 404 : 409, {
          error: { code: missing ? "NOT_FOUND" : "CONFLICT", message: result.error },
        });
        return true;
      }
      send(res, 200, result.session);
    } catch {
      sendInternalError(res);
    }
    return true;
  }

  const resumeMatch = /^\/api\/v1\/sessions\/([^/]+)\/resume$/.exec(url.pathname);
  if (method === "POST" && resumeMatch) {
    const id = resumeMatch[1]!;
    let existing: Awaited<ReturnType<typeof plane.getSessionDurable>>;
    try {
      existing = await plane.getSessionDurable(id);
      if (!existing || !canAccess(ctx, existing.repositoryId)) {
        sendForbidden(res);
        return true;
      }
    } catch {
      sendInternalError(res);
      return true;
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await readJson(req);
      if (parsed !== undefined && parsed !== null) {
        if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body");
        body = parsed as Record<string, unknown>;
      }
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    if (!validResumeBody(body)) {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid resume overrides" },
      });
      return true;
    }
    try {
      const result = await plane.resumeSessionDurable(id, {
        ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
        ...(typeof body.timeout === "number" ? { timeout: body.timeout } : {}),
        ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
      });
      if (!result.ok) {
        const missing = result.error === "session not found";
        const conflict =
          existing.type === "scheduled" ||
          /already terminal|must be terminal|no agent|conflicted|changed before/i.test(
            result.error,
          );
        send(res, missing ? 404 : conflict ? 409 : 400, {
          error: {
            code: missing ? "NOT_FOUND" : conflict ? "CONFLICT" : "VALIDATION_ERROR",
            message: result.error,
          },
        });
        return true;
      }
      send(res, result.created ? 201 : 200, { ...result.session, created: result.created });
    } catch {
      sendInternalError(res);
    }
    return true;
  }

  return false;
}
