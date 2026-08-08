import { readJson, send, type RouteCtx } from "./local-http.ts";

/** Session collection + sub-resource routes. Returns true if handled. */
export async function handleSessionRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "POST" && url.pathname === "/api/v1/sessions") {
    try {
      const body = await readJson(req);
      const result = plane.createSession(body);
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
    send(res, 200, page);
    return true;
  }

  const cancelMatch = /^\/api\/v1\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
  if (method === "POST" && cancelMatch) {
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
    const result = plane.resumeSession(id);
    if (!result.ok) {
      send(res, 400, {
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
    send(res, 200, { items: plane.getLogs(id) });
    return true;
  }

  const archiveMatch = /^\/api\/v1\/sessions\/([^/]+)\/archive$/.exec(url.pathname);
  if (method === "POST" && archiveMatch) {
    const id = archiveMatch[1]!;
    const archived = plane.archiveSessionLogs(id);
    send(res, 200, archived);
    return true;
  }

  const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && sessionMatch) {
    const id = sessionMatch[1]!;
    const session = plane.getSession(id);
    if (!session) {
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
