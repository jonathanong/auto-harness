import { isSessionStatus } from "@auto-harness/shared";

import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import {
  InvalidSessionCursorError,
  InvalidSessionListQueryError,
  type SessionListSort,
} from "./control-plane-sessions-page.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { parseLogQuery } from "./log-query.ts";

type SessionListQueryParam =
  | "limit"
  | "cursor"
  | "repositoryId"
  | "status"
  | "hostId"
  | "sort"
  | "concurrencyId"
  | "scheduleId";

function readSingleQueryParam(url: URL, name: SessionListQueryParam): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new InvalidSessionListQueryError(`${name} must appear only once`);
  }
  const value = values[0];
  if (value === "") throw new InvalidSessionListQueryError(`${name} must not be empty`);
  return value;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidSessionListQueryError("limit must be a base-10 integer between 1 and 100");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidSessionListQueryError("limit must be a base-10 integer between 1 and 100");
  }
  return limit;
}

function parseStatus(value: string | undefined): string | undefined {
  if (value === undefined || value === "all" || isSessionStatus(value)) return value;
  throw new InvalidSessionListQueryError("status must be all or a recognized session status");
}

function parseSort(value: string | undefined): SessionListSort | undefined {
  if (
    value === undefined ||
    value === "latest" ||
    value === "oldest" ||
    value === "priority_desc" ||
    value === "priority_asc"
  ) {
    return value;
  }
  throw new InvalidSessionListQueryError("invalid sort");
}

function canAccess(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

function sessionScope(ctx: RouteCtx) {
  return ctx.principal
    ? {
        repositoryIds: ctx.principal.allowedRepositoryIds,
        hostId: ctx.principal.boundHostId,
      }
    : undefined;
}

/** Durable session collection, detail, and log-history GET routes. */
export async function handleSessionReadRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  if (method === "GET" && url.pathname === "/api/v1/sessions") {
    try {
      const limit = parseLimit(readSingleQueryParam(url, "limit"));
      const cursor = readSingleQueryParam(url, "cursor");
      const repositoryId = readSingleQueryParam(url, "repositoryId");
      const status = parseStatus(readSingleQueryParam(url, "status"));
      const hostId = readSingleQueryParam(url, "hostId");
      const sortRaw = parseSort(readSingleQueryParam(url, "sort"));
      const concurrencyId = readSingleQueryParam(url, "concurrencyId");
      const scheduleId = readSingleQueryParam(url, "scheduleId");
      const page = await plane.listSessionsPageDurable({
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(repositoryId !== undefined ? { repositoryId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(hostId !== undefined ? { hostId } : {}),
        ...(sortRaw !== undefined ? { sort: sortRaw } : {}),
        ...(concurrencyId !== undefined ? { concurrencyId } : {}),
        ...(scheduleId !== undefined ? { scheduleId } : {}),
        ...(sessionScope(ctx) ? { scope: sessionScope(ctx) } : {}),
      });
      send(res, 200, page);
    } catch (error) {
      if (
        error instanceof InvalidSessionCursorError ||
        error instanceof InvalidSessionListQueryError
      ) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
      } else {
        sendInternalError(res);
      }
    }
    return true;
  }

  const logsMatch = /^\/api\/v1\/sessions\/([^/]+)\/logs$/.exec(url.pathname);
  if (method === "GET" && logsMatch) {
    const query = parseLogQuery(url.searchParams);
    if (!query.ok) {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: query.error } });
      return true;
    }
    try {
      const session = await plane.getSessionDurable(logsMatch[1]!);
      if (
        !session ||
        !canAccess(ctx, session.repositoryId) ||
        !mayAccessHost(ctx.principal, session.hostId)
      ) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "session not found" } });
      } else {
        send(res, 200, { items: await plane.getLogsDurable(logsMatch[1]!, query.query) });
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }

  const archiveMatch = /^\/api\/v1\/sessions\/([^/]+)\/archive$/.exec(url.pathname);
  if (method === "POST" && archiveMatch) {
    const id = archiveMatch[1]!;
    const session = plane.getSession(id);
    if (session && !canAccess(ctx, session.repositoryId)) {
      send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
      return true;
    }
    send(res, 200, plane.archiveSessionLogs(id));
    return true;
  }

  const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (method !== "GET" || !sessionMatch) return false;
  try {
    const session = await plane.getSessionDurable(sessionMatch[1]!);
    if (
      !session ||
      !canAccess(ctx, session.repositoryId) ||
      !mayAccessHost(ctx.principal, session.hostId)
    ) {
      send(res, 404, { error: { code: "NOT_FOUND", message: "session not found" } });
    } else {
      send(res, 200, session);
    }
  } catch {
    sendInternalError(res);
  }
  return true;
}
