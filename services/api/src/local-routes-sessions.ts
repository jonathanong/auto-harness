import { readJson, send, type RouteCtx } from "./local-http.ts";
import { mayAccessRepository } from "./auth-policy.ts";

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

  if (method === "POST" && url.pathname === "/api/v1/sessions") {
    try {
      const body = await readJson(req);
      const repositoryId =
        typeof (body as { repositoryId?: unknown }).repositoryId === "string"
          ? (body as { repositoryId: string }).repositoryId
          : undefined;
      if (!canAccess(ctx, repositoryId)) {
        sendForbidden(res);
        return true;
      }
      const input =
        ctx.principal && body && typeof body === "object"
          ? {
              ...(body as Record<string, unknown>),
              metadata: {
                ...((body as Record<string, unknown>).metadata as
                  | Record<string, unknown>
                  | undefined),
                createdBy: ctx.principal.id,
              },
            }
          : body;
      const result = plane.createSession(input);
      if (!result.ok) {
        send(res, result.code === "CONFLICT" ? 409 : 400, {
          error: {
            code: result.code ?? "VALIDATION_ERROR",
            message: result.error,
          },
        });
        return true;
      }
      send(res, 201, result.session);
      return true;
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
      return true;
    }
  }

  if (method === "GET" && url.pathname === "/api/v1/sessions") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const page = plane.listSessionsPage({
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
      ...(url.searchParams.get("hostId") ? { hostId: url.searchParams.get("hostId")! } : {}),
      ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
      ...(url.searchParams.get("q") ? { q: url.searchParams.get("q")! } : {}),
    });
    const items = page.items.filter((session) => canAccess(ctx, session.repositoryId));
    send(res, 200, {
      ...page,
      items,
    });
    return true;
  }

  const cancelMatch = /^\/api\/v1\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
  if (method === "POST" && cancelMatch) {
    const session = plane.getSession(cancelMatch[1]!);
    if (session && (!canAccess(ctx, session.repositoryId) || !canCancel(ctx, session))) {
      sendForbidden(res);
      return true;
    }
    const result = plane.cancelSession(cancelMatch[1]!);
    if (!result.ok) {
      send(res, 400, { error: { code: "CANCEL_ERROR", message: result.error } });
      return true;
    }
    send(res, 200, result.session);
    return true;
  }

  const resumeMatch = /^\/api\/v1\/sessions\/([^/]+)\/resume$/.exec(url.pathname);
  if (method === "POST" && resumeMatch) {
    const id = resumeMatch[1]!;
    const existing = plane.getSession(id);
    if (!existing) {
      sendForbidden(res);
      return true;
    }
    if (!canAccess(ctx, existing.repositoryId)) {
      sendForbidden(res);
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
    const result = plane.resumeSession(id, {
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
      ...(typeof body.timeout === "number" ? { timeout: body.timeout } : {}),
      ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
    });
    if (!result.ok) {
      send(res, existing.type === "scheduled" ? 409 : 400, {
        error: { code: "RESUME_ERROR", message: result.error },
      });
      return true;
    }
    send(res, 201, result.session);
    return true;
  }

  const logsMatch = /^\/api\/v1\/sessions\/([^/]+)\/logs$/.exec(url.pathname);
  if (method === "GET" && logsMatch) {
    const id = logsMatch[1]!;
    const session = plane.getSession(id);
    if (session && !canAccess(ctx, session.repositoryId)) {
      sendForbidden(res);
      return true;
    }
    send(res, 200, { items: plane.getLogs(id) });
    return true;
  }

  const archiveMatch = /^\/api\/v1\/sessions\/([^/]+)\/archive$/.exec(url.pathname);
  if (method === "POST" && archiveMatch) {
    const id = archiveMatch[1]!;
    const session = plane.getSession(id);
    if (session && !canAccess(ctx, session.repositoryId)) {
      sendForbidden(res);
      return true;
    }
    const archived = plane.archiveSessionLogs(id);
    send(res, 200, archived);
    return true;
  }

  const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && sessionMatch) {
    const id = sessionMatch[1]!;
    const session = plane.getSession(id);
    if (!session || !canAccess(ctx, session.repositoryId)) {
      send(res, 404, {
        error: { code: "NOT_FOUND", message: "session not found" },
      });
      return true;
    }
    send(res, 200, session);
    return true;
  }

  return false;
}
