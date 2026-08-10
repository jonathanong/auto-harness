/* eslint-disable max-lines -- repository and schedule scope gates share one route module. */
import { readJson, send, type RouteCtx } from "./local-http.ts";
import { mayAccessRepository } from "./auth-policy.ts";

function scoped(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

function hidden(res: RouteCtx["res"]): void {
  send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
}

/** Repository CRUD routes. Returns true if handled. */
export async function handleRepositoryRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/repositories") {
    send(res, 200, { items: plane.listRepositories().filter((repo) => scoped(ctx, repo.id)) });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/repositories") {
    try {
      const body = (await readJson(req)) as Record<string, unknown>;
      const result = plane.createRepository({
        name: String(body.name ?? ""),
        url: String(body.url ?? ""),
        ...(typeof body.defaultBranch === "string" ? { defaultBranch: body.defaultBranch } : {}),
        ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
        ...(typeof body.terminalHookScript === "string"
          ? { terminalHookScript: body.terminalHookScript }
          : {}),
      });
      if (!result.ok) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: result.error },
        });
        return true;
      }
      send(res, 201, result.repository);
      return true;
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
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
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        const result = plane.updateRepository(id, {
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
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return true;
      }
    }
    if (method === "DELETE") {
      if (!scoped(ctx, id)) {
        hidden(res);
        return true;
      }
      const result = plane.deleteRepository(id);
      if (!result.ok) {
        send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
        return true;
      }
      send(res, 204, null);
      return true;
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
    try {
      const body = (await readJson(req)) as Record<string, unknown>;
      const hasAccount = typeof body.providerAccountId === "string";
      const hasCommand = typeof body.commandId === "string";
      if (
        typeof body.repositoryId !== "string" ||
        typeof body.name !== "string" ||
        hasAccount === hasCommand ||
        typeof body.cron !== "string" ||
        typeof body.timeout !== "number" ||
        typeof body.nextRunAt !== "string"
      ) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message:
              "repositoryId, name, cron, timeout, nextRunAt are required, plus exactly one of providerAccountId or commandId",
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
      if (!scoped(ctx, body.repositoryId)) {
        hidden(res);
        return true;
      }
      const result = plane.putSchedule({
        repositoryId: body.repositoryId,
        name: body.name,
        ...(hasAccount ? { providerAccountId: body.providerAccountId as string } : {}),
        ...(hasCommand ? { commandId: body.commandId as string } : {}),
        cron: body.cron,
        timeout: body.timeout,
        nextRunAt: body.nextRunAt,
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        ...(typeof body.id === "string" ? { id: body.id } : {}),
      });
      if (!result.ok) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      send(res, 201, result.schedule);
      return true;
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
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
    const result = await plane.triggerScheduleDurable(schedTrigger[1]!, new Date().toISOString());
    if (!result.ok) {
      send(res, 400, { error: { code: "TRIGGER_ERROR", message: result.error } });
      return true;
    }
    send(res, 201, result.session);
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
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (body.ref !== undefined && typeof body.ref !== "string") {
          send(res, 400, {
            error: {
              code: "VALIDATION_ERROR",
              message: "ref must be a valid scheduled branch name",
            },
          });
          return true;
        }
        if (typeof body.repositoryId === "string" && !scoped(ctx, body.repositoryId)) {
          hidden(res);
          return true;
        }
        const result = plane.updateSchedule(id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.providerAccountId === "string"
            ? { providerAccountId: body.providerAccountId }
            : {}),
          ...(typeof body.commandId === "string" ? { commandId: body.commandId } : {}),
          ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
          ...(typeof body.timeout === "number" ? { timeout: body.timeout } : {}),
          ...(typeof body.nextRunAt === "string" ? { nextRunAt: body.nextRunAt } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
          ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
        });
        if (!result.ok) {
          const notFound = result.error === "schedule not found";
          send(res, notFound ? 404 : 400, {
            error: { code: notFound ? "NOT_FOUND" : "VALIDATION_ERROR", message: result.error },
          });
          return true;
        }
        send(res, 200, result.schedule);
        return true;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return true;
      }
    }
    if (method === "DELETE") {
      const result = plane.deleteSchedule(id);
      if (!result.ok) {
        send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
        return true;
      }
      send(res, 204, null);
      return true;
    }
  }
  return false;
}
