/* eslint-disable max-lines -- repository and schedule scope gates share one route module. */
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessRepository } from "./auth-policy.ts";

function scoped(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

function hidden(res: RouteCtx["res"]): void {
  send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
}

function scheduleTriggerError(error: string): { status: number; code: string } {
  if (/not found/i.test(error)) return { status: 404, code: "NOT_FOUND" };
  if (/disabled|concurrent|updated|claimed|already active|conflict/i.test(error)) {
    return { status: 409, code: "CONFLICT" };
  }
  return { status: 400, code: "TRIGGER_ERROR" };
}

/** Repository CRUD routes. Returns true if handled. */
export async function handleRepositoryRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/repositories") {
    send(res, 200, { items: plane.listRepositories().filter((repo) => scoped(ctx, repo.id)) });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/repositories") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
      return true;
    }
    try {
      const result = await plane.createRepositoryDurable({
        name: String(body.name ?? ""),
        url: String(body.url ?? ""),
        ...(typeof body.defaultBranch === "string" ? { defaultBranch: body.defaultBranch } : {}),
        ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
        ...(typeof body.terminalHookScript === "string"
          ? { terminalHookScript: body.terminalHookScript }
          : {}),
      });
      if (!result.ok) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      send(res, 201, result.repository);
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }
  const repoMatch = /^\/api\/v1\/repositories\/([^/]+)$/.exec(url.pathname);
  if (repoMatch) {
    const id = repoMatch[1]!;
    if (method === "GET") {
      const repo = plane.getRepository(id);
      if (!repo || !scoped(ctx, repo.id)) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "repository not found" } });
        return true;
      }
      send(res, 200, repo);
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      if (!scoped(ctx, id)) {
        hidden(res);
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return true;
      }
      try {
        const result = await plane.updateRepositoryDurable(id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.url === "string" ? { url: body.url } : {}),
          ...(typeof body.defaultBranch === "string" ? { defaultBranch: body.defaultBranch } : {}),
          ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
          ...(typeof body.terminalHookScript === "string"
            ? { terminalHookScript: body.terminalHookScript }
            : {}),
        });
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        send(res, 200, result.repository);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      if (!scoped(ctx, id)) {
        hidden(res);
        return true;
      }
      try {
        const result = await plane.deleteRepositoryDurable(id);
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        send(res, 204, null);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
  }
  return false;
}

/** Schedule CRUD + trigger routes. Returns true if handled. */
export async function handleScheduleRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/schedules") {
    send(res, 200, {
      items: plane.listSchedules().filter((schedule) => scoped(ctx, schedule.repositoryId)),
    });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/schedules") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
      if (
        typeof body.repositoryId !== "string" ||
        typeof body.name !== "string" ||
        typeof body.target !== "object" ||
        body.target === null ||
        typeof body.cron !== "string" ||
        typeof body.timeout !== "number"
      ) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: "repositoryId, name, target, cron, and timeout are required",
          },
        });
        return true;
      }
      if (body.ref !== undefined && typeof body.ref !== "string") {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "ref must be a valid scheduled branch name" },
        });
        return true;
      }
      if (body.nextRunAt !== undefined && typeof body.nextRunAt !== "string") {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: "nextRunAt must be an ISO-8601 UTC timestamp",
          },
        });
        return true;
      }
      if (!scoped(ctx, body.repositoryId)) {
        hidden(res);
        return true;
      }
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
      return true;
    }
    try {
      const result = await plane.putScheduleDurable({
        repositoryId: body.repositoryId,
        name: body.name,
        target: body.target,
        ...(body.fallbacks !== undefined ? { fallbacks: body.fallbacks } : {}),
        cron: body.cron,
        timeout: body.timeout,
        ...(typeof body.queueTtlSeconds === "number"
          ? { queueTtlSeconds: body.queueTtlSeconds }
          : {}),
        ...(typeof body.nextRunAt === "string" ? { nextRunAt: body.nextRunAt } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        ...(typeof body.concurrencyId === "string" ? { concurrencyId: body.concurrencyId } : {}),
        ...(typeof body.id === "string" ? { id: body.id } : {}),
      });
      if (!result.ok) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      send(res, 201, result.schedule);
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }
  const schedTrigger = /^\/api\/v1\/schedules\/([^/]+)\/trigger$/.exec(url.pathname);
  if (method === "POST" && schedTrigger) {
    const existing = plane.getSchedule(schedTrigger[1]!);
    if (existing && !scoped(ctx, existing.repositoryId)) {
      hidden(res);
      return true;
    }
    let result: Awaited<ReturnType<typeof plane.triggerScheduleDurable>>;
    try {
      result = await plane.triggerScheduleDurable(schedTrigger[1]!, new Date().toISOString());
    } catch {
      sendInternalError(res);
      return true;
    }
    if (!result.ok) {
      const mapped = scheduleTriggerError(result.error);
      send(res, mapped.status, { error: { code: mapped.code, message: result.error } });
      return true;
    }
    if (!scoped(ctx, result.session.repositoryId)) {
      hidden(res);
      return true;
    }
    send(res, result.created ? 201 : 200, { ...result.session, created: result.created });
    return true;
  }
  const schedMatch = /^\/api\/v1\/schedules\/([^/]+)$/.exec(url.pathname);
  if (schedMatch) {
    const id = schedMatch[1]!;
    const existing = plane.getSchedule(id);
    if (existing && !scoped(ctx, existing.repositoryId)) {
      hidden(res);
      return true;
    }
    if (method === "GET") {
      const s = existing;
      if (!s) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } });
        return true;
      }
      send(res, 200, s);
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      if (!existing) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } });
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
        if (body.ref !== undefined && typeof body.ref !== "string") {
          send(res, 400, {
            error: {
              code: "VALIDATION_ERROR",
              message: "ref must be a valid scheduled branch name",
            },
          });
          return true;
        }
        if (body.nextRunAt !== undefined && typeof body.nextRunAt !== "string") {
          send(res, 400, {
            error: {
              code: "VALIDATION_ERROR",
              message: "nextRunAt must be an ISO-8601 UTC timestamp",
            },
          });
          return true;
        }
        if (typeof body.repositoryId === "string" && !scoped(ctx, body.repositoryId)) {
          hidden(res);
          return true;
        }
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return true;
      }
      try {
        const result = await plane.updateScheduleDurable(id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(body.target !== undefined ? { target: body.target } : {}),
          ...(body.fallbacks !== undefined ? { fallbacks: body.fallbacks } : {}),
          ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
          ...(typeof body.timeout === "number" ? { timeout: body.timeout } : {}),
          ...(typeof body.queueTtlSeconds === "number"
            ? { queueTtlSeconds: body.queueTtlSeconds }
            : {}),
          ...(typeof body.nextRunAt === "string" ? { nextRunAt: body.nextRunAt } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
          ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
          ...(typeof body.concurrencyId === "string" ? { concurrencyId: body.concurrencyId } : {}),
        });
        if (!result.ok) {
          send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
          return true;
        }
        send(res, 200, result.schedule);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      try {
        const result = await plane.deleteScheduleDurable(id);
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        send(res, 204, null);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
  }
  return false;
}
