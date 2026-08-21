/* eslint-disable max-lines -- repository and schedule scope gates share one route module. */
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessRepository } from "./auth-policy.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { canAuthorSessions } from "./local-routes-session-access.ts";

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
    try {
      const repositories = (await plane.listRepositoriesDurable()).filter((repo) =>
        scoped(ctx, repo.id),
      );
      const counts = await plane.listRepositoryCountsDurable(
        repositories.map((repo) => repo.id),
        ctx.principal?.boundHostId,
      );
      send(res, 200, {
        items: repositories.map((repo) => ({ ...repo, ...counts.get(repo.id) })),
      });
    } catch {
      sendInternalError(res);
    }
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
        if (
          !(await writeRouteAudit(ctx, {
            action: "repository:create",
            resourceType: "repository",
            resourceId: "new",
            outcome: "failed",
          }))
        )
          return true;
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "repository:create",
          resourceType: "repository",
          resourceId: result.repository.id,
          repositoryId: result.repository.id,
        }))
      )
        return true;
      send(res, 201, result.repository);
      return true;
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: "repository:create",
          resourceType: "repository",
          resourceId: "new",
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
      return true;
    }
  }
  const repoMatch = /^\/api\/v1\/repositories\/([^/]+)$/.exec(url.pathname);
  if (repoMatch) {
    const id = repoMatch[1]!;
    if (method === "GET") {
      try {
        const repo = await plane.getRepositoryDurable(id);
        if (!repo || !scoped(ctx, repo.id)) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "repository not found" } });
          return true;
        }
        send(res, 200, repo);
      } catch {
        sendInternalError(res);
      }
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      if (!scoped(ctx, id)) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "repository:update",
            resourceType: "repository",
            resourceId: id,
            repositoryId: id,
            outcome: "denied",
          }))
        )
          return true;
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
          if (
            !(await writeRouteAudit(ctx, {
              action: "repository:update",
              resourceType: "repository",
              resourceId: id,
              repositoryId: id,
              outcome: "failed",
            }))
          )
            return true;
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "repository:update",
            resourceType: "repository",
            resourceId: id,
            repositoryId: id,
          }))
        )
          return true;
        send(res, 200, result.repository);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "repository:update",
            resourceType: "repository",
            resourceId: id,
            repositoryId: id,
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      if (!scoped(ctx, id)) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "repository:delete",
            resourceType: "repository",
            resourceId: id,
            repositoryId: id,
            outcome: "denied",
          }))
        )
          return true;
        hidden(res);
        return true;
      }
      try {
        const result = await plane.deleteRepositoryDurable(id);
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "repository:delete",
              resourceType: "repository",
              resourceId: id,
              repositoryId: id,
              outcome: "failed",
            }))
          )
            return true;
          send(res, result.conflict ? 409 : 404, {
            error: {
              code: result.conflict ? "CONFLICT" : "NOT_FOUND",
              message: result.error,
              ...(result.dependencies ? { dependencies: result.dependencies } : {}),
            },
          });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "repository:delete",
            resourceType: "repository",
            resourceId: id,
            repositoryId: id,
          }))
        )
          return true;
        send(res, 204, null);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "repository:delete",
            resourceType: "repository",
            resourceId: id,
            repositoryId: id,
            outcome: "failed",
          }))
        )
          return true;
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
    try {
      send(res, 200, {
        items: (await plane.listSchedulesDurable()).filter((schedule) =>
          scoped(ctx, schedule.repositoryId),
        ),
      });
    } catch {
      sendInternalError(res);
    }
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
      if (body.prompt !== undefined && typeof body.prompt !== "string") {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "prompt must be a string" },
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
      if (!canAuthorSessions(ctx) || !scoped(ctx, body.repositoryId)) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:create",
            resourceType: "schedule",
            resourceId: "new",
            repositoryId: body.repositoryId,
            outcome: "denied",
          }))
        )
          return true;
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
        ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
        ...(typeof body.id === "string" ? { id: body.id } : {}),
      });
      if (!result.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:create",
            resourceType: "schedule",
            resourceId: "new",
            repositoryId: body.repositoryId,
            outcome: "failed",
          }))
        )
          return true;
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "schedule:create",
          resourceType: "schedule",
          resourceId: result.schedule.id,
          repositoryId: result.schedule.repositoryId,
        }))
      )
        return true;
      send(res, 201, result.schedule);
      return true;
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: "schedule:create",
          resourceType: "schedule",
          resourceId: "new",
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
      return true;
    }
  }
  const schedTrigger = /^\/api\/v1\/schedules\/([^/]+)\/trigger$/.exec(url.pathname);
  if (method === "POST" && schedTrigger) {
    let triggerExisting: Awaited<ReturnType<typeof plane.getScheduleDurable>>;
    try {
      triggerExisting = await plane.getScheduleDurable(schedTrigger[1]!);
      if (
        !canAuthorSessions(ctx) ||
        (triggerExisting && !scoped(ctx, triggerExisting.repositoryId))
      ) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:trigger",
            resourceType: "schedule",
            resourceId: schedTrigger[1]!,
            // Missing (not just unauthorized) when !canAuthorSessions(ctx) alone triggered
            // this branch — a direct .repositoryId here would throw on that path.
            repositoryId: triggerExisting?.repositoryId,
            outcome: "denied",
          }))
        )
          return true;
        hidden(res);
        return true;
      }
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: "schedule:trigger",
          resourceType: "schedule",
          resourceId: schedTrigger[1]!,
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
      return true;
    }
    let result: Awaited<ReturnType<typeof plane.triggerScheduleDurable>>;
    try {
      result = await plane.triggerScheduleDurable(schedTrigger[1]!, new Date().toISOString());
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: "schedule:trigger",
          resourceType: "schedule",
          resourceId: schedTrigger[1]!,
          ...(triggerExisting?.repositoryId ? { repositoryId: triggerExisting.repositoryId } : {}),
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
      return true;
    }
    if (!result.ok) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "schedule:trigger",
          resourceType: "schedule",
          resourceId: schedTrigger[1]!,
          ...(triggerExisting?.repositoryId ? { repositoryId: triggerExisting.repositoryId } : {}),
          outcome: "failed",
        }))
      )
        return true;
      const mapped = scheduleTriggerError(result.error);
      send(res, mapped.status, { error: { code: mapped.code, message: result.error } });
      return true;
    }
    if (!scoped(ctx, result.session.repositoryId)) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "schedule:trigger",
          resourceType: "schedule",
          resourceId: schedTrigger[1]!,
          repositoryId: result.session.repositoryId,
          outcome: "denied",
        }))
      )
        return true;
      hidden(res);
      return true;
    }
    if (
      !(await writeRouteAudit(ctx, {
        action: "schedule:trigger",
        resourceType: "schedule",
        resourceId: schedTrigger[1]!,
        repositoryId: result.session.repositoryId,
        metadata: { created: result.created, sessionId: result.session.id },
      }))
    )
      return true;
    send(res, result.created ? 201 : 200, { ...result.session, created: result.created });
    return true;
  }
  const schedMatch = /^\/api\/v1\/schedules\/([^/]+)$/.exec(url.pathname);
  if (schedMatch) {
    const id = schedMatch[1]!;
    let existing: Awaited<ReturnType<typeof plane.getScheduleDurable>>;
    try {
      existing = await plane.getScheduleDurable(id);
    } catch {
      sendInternalError(res);
      return true;
    }
    // Schedule writes mint sessions (or stop a schedule from minting). Bound daemon
    // keys cannot author work; they get the same hidden 404 as an unknown schedule.
    // Reads stay on the authenticated GET grant — canAuthorSessions is write-only.
    const outOfScope = Boolean(existing && !scoped(ctx, existing.repositoryId));
    const writeBlocked = method !== "GET" && !canAuthorSessions(ctx);
    if (writeBlocked || outOfScope) {
      if (
        !(await writeRouteAudit(ctx, {
          action: `schedule:${method === "DELETE" ? "delete" : "update"}`,
          resourceType: "schedule",
          resourceId: id,
          // Missing (not just unauthorized) when the first OR-clause alone triggered this
          // branch — a direct .repositoryId here would throw on that path.
          repositoryId: existing?.repositoryId,
          outcome: "denied",
        }))
      )
        return true;
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
        if (body.prompt !== undefined && typeof body.prompt !== "string") {
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: "prompt must be a string" },
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
          ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
        });
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "schedule:update",
              resourceType: "schedule",
              resourceId: id,
              ...(existing?.repositoryId ? { repositoryId: existing.repositoryId } : {}),
              outcome: "failed",
            }))
          )
            return true;
          send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:update",
            resourceType: "schedule",
            resourceId: id,
            repositoryId: result.schedule.repositoryId,
          }))
        )
          return true;
        send(res, 200, result.schedule);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:update",
            resourceType: "schedule",
            resourceId: id,
            ...(existing?.repositoryId ? { repositoryId: existing.repositoryId } : {}),
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      try {
        const result = await plane.deleteScheduleDurable(id);
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "schedule:delete",
              resourceType: "schedule",
              resourceId: id,
              ...(existing?.repositoryId ? { repositoryId: existing.repositoryId } : {}),
              outcome: "failed",
            }))
          )
            return true;
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:delete",
            resourceType: "schedule",
            resourceId: id,
            ...(existing?.repositoryId ? { repositoryId: existing.repositoryId } : {}),
          }))
        )
          return true;
        send(res, 204, null);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:delete",
            resourceType: "schedule",
            resourceId: id,
            ...(existing?.repositoryId ? { repositoryId: existing.repositoryId } : {}),
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
        return true;
      }
    }
  }
  return false;
}
