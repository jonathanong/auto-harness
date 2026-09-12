/* eslint-disable max-lines -- repository and schedule scope gates share one route module. */
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { writeRouteAudit } from "./local-audit.ts";
import {
  commitMutationAudit,
  readJsonBodyWithAudit,
  repositoryInScope,
  sendHiddenNotFound,
  sendRouteError,
} from "./local-audited-route.ts";
import { canAuthorSessions } from "./local-routes-session-access.ts";
import { may, mayAccessRepository } from "./auth-policy.ts";
import { SYSTEM_AUDIT_ACTOR } from "./audit.ts";
import {
  InvalidRepositoryCursorError,
  InvalidRepositoryListQueryError,
} from "./control-plane-repositories-page.ts";
import { sendListPage } from "./local-list-page.ts";

function scoped(ctx: RouteCtx, repositoryId: string | null | undefined): boolean {
  if (repositoryId === "" || repositoryId === null) {
    return !ctx.principal || mayAccessRepository(ctx.principal, null);
  }
  return repositoryInScope(ctx, repositoryId);
}

function publicSchedule<T extends { repositoryId: string }>(
  schedule: T,
): Omit<T, "repositoryId"> & {
  repositoryId: string | null;
} {
  return { ...schedule, repositoryId: schedule.repositoryId || null };
}

function cleanupOverrideAllowed(ctx: RouteCtx, body: Record<string, unknown>): boolean {
  return (
    body.destroyWorkspaceAfter === undefined ||
    body.destroyWorkspaceAfter === null ||
    !ctx.principal ||
    may(ctx.principal, "fleet:exec-config")
  );
}

function workspaceScheduleBodyInvalid(body: Record<string, unknown>): string | undefined {
  if (body.repositoryId !== null) return undefined;
  if (typeof body.workspacePoolId !== "string" || !body.workspacePoolId.trim()) {
    return "workspacePoolId is required for workspace schedules";
  }
  if (body.ref !== undefined) return "ref is not supported for workspace schedules";
  if (body.requiredLabels !== undefined && !Array.isArray(body.requiredLabels)) {
    return "requiredLabels must be an array";
  }
  if (Array.isArray(body.requiredLabels) && body.requiredLabels.length > 0) {
    return "requiredLabels are not supported for workspace schedules";
  }
  if (body.setupScript !== undefined) return "setupScript is not supported for workspace schedules";
  if (
    body.setupProfileId !== undefined &&
    body.setupProfileId !== null &&
    (typeof body.setupProfileId !== "string" || !body.setupProfileId.trim())
  ) {
    return "setupProfileId must be a non-empty string";
  }
  if (
    body.destroyWorkspaceAfter !== undefined &&
    body.destroyWorkspaceAfter !== null &&
    typeof body.destroyWorkspaceAfter !== "boolean"
  ) {
    return "destroyWorkspaceAfter must be a boolean";
  }
  return undefined;
}

function hidden(res: RouteCtx["res"]): void {
  sendHiddenNotFound(res);
}

type RepositoryListQueryParam = "limit" | "cursor";

function readSingleRepositoryListQueryParam(
  url: URL,
  name: RepositoryListQueryParam,
): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new InvalidRepositoryListQueryError(`${name} must appear only once`);
  }
  const value = values[0];
  if (value === "") throw new InvalidRepositoryListQueryError(`${name} must not be empty`);
  return value;
}

function parseRepositoryListLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new InvalidRepositoryListQueryError("limit must be a base-10 integer between 1 and 100");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidRepositoryListQueryError("limit must be a base-10 integer between 1 and 100");
  }
  return limit;
}

function repositoryListScope(ctx: RouteCtx) {
  return ctx.principal ? { repositoryIds: ctx.principal.allowedRepositoryIds } : undefined;
}

function scheduleTriggerError(error: string): { status: number; code: string } {
  if (/not found/i.test(error)) return { status: 404, code: "NOT_FOUND" };
  if (/repository admission is (?:closed|paused|draining)/i.test(error)) {
    return { status: 409, code: "REPOSITORY_ADMISSION_CLOSED" };
  }
  if (/disabled|concurrent|updated|claimed|already active|conflict/i.test(error)) {
    return { status: 409, code: "CONFLICT" };
  }
  return { status: 400, code: "TRIGGER_ERROR" };
}

function repositoryUpdateError(error: string): { status: number; code: string } {
  if (/not found/i.test(error)) return { status: 404, code: "NOT_FOUND" };
  if (/already (?:in use|exists)/i.test(error)) return { status: 409, code: "CONFLICT" };
  return { status: 400, code: "VALIDATION_ERROR" };
}

const REPOSITORY_MUTATION_STRING_FIELDS = [
  "name",
  "url",
  "defaultBranch",
  "setupScript",
  "terminalHookScript",
] as const;

function repositoryMutationBodyError(body: unknown, operation: "create" | "update"): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return `repository ${operation} body must be an object`;
  }
  const record = body as Record<string, unknown>;
  for (const field of REPOSITORY_MUTATION_STRING_FIELDS) {
    if (Object.hasOwn(record, field) && typeof record[field] !== "string") {
      return `${field} must be a string`;
    }
  }
  return null;
}

/** Repository CRUD routes. Returns true if handled. */
export async function handleRepositoryRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/repositories") {
    try {
      const limit = parseRepositoryListLimit(readSingleRepositoryListQueryParam(url, "limit"));
      const cursor = readSingleRepositoryListQueryParam(url, "cursor");
      const page = await plane.listRepositoriesPageDurable({
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(repositoryListScope(ctx) ? { scope: repositoryListScope(ctx) } : {}),
      });
      const counts = await plane.listRepositoryCountsDurable(
        page.items.map((repo) => repo.id),
        ctx.principal?.boundHostId,
      );
      send(res, 200, {
        ...page,
        items: page.items.map((repo) => ({ ...repo, ...counts.get(repo.id) })),
      });
    } catch (error) {
      if (
        error instanceof InvalidRepositoryCursorError ||
        error instanceof InvalidRepositoryListQueryError
      ) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
      } else {
        sendInternalError(res);
      }
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/repositories") {
    const createAudit = {
      action: "repository:create",
      resourceType: "repository",
      resourceId: "new",
    } as const;
    const parsed = await readJsonBodyWithAudit(ctx, { ...createAudit, outcome: "failed" });
    if (!parsed.ok) return true;
    const bodyError = repositoryMutationBodyError(parsed.body, "create");
    if (bodyError) {
      if (!(await commitMutationAudit(ctx, { ...createAudit, outcome: "failed" }))) return true;
      sendRouteError(res, 400, "VALIDATION_ERROR", bodyError);
      return true;
    }
    const body = parsed.body as Record<string, unknown>;
    try {
      const result = await plane.createRepositoryDurable({
        name: typeof body.name === "string" ? body.name : "",
        url: typeof body.url === "string" ? body.url : "",
        ...(typeof body.defaultBranch === "string" ? { defaultBranch: body.defaultBranch } : {}),
        ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
        ...(typeof body.terminalHookScript === "string"
          ? { terminalHookScript: body.terminalHookScript }
          : {}),
      });
      if (!result.ok) {
        if (!(await commitMutationAudit(ctx, { ...createAudit, outcome: "failed" }))) return true;
        sendRouteError(res, 400, "VALIDATION_ERROR", result.error);
        return true;
      }
      if (
        !(await commitMutationAudit(ctx, {
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
      if (!(await commitMutationAudit(ctx, { ...createAudit, outcome: "failed" }))) return true;
      sendInternalError(res);
      return true;
    }
  }
  const admissionMatch = /^\/api\/v1\/repositories\/([^/]+)\/(pause|drain|activate)$/.exec(
    url.pathname,
  );
  if (method === "POST" && admissionMatch) {
    const id = admissionMatch[1]!;
    const operation = admissionMatch[2] as "pause" | "drain" | "activate";
    if (!scoped(ctx, id)) {
      if (
        !(await writeRouteAudit(ctx, {
          action: `repository:${operation}`,
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
      let result;
      if (operation === "pause") result = await plane.pauseRepositoryDurable(id);
      else if (operation === "drain") result = await plane.drainRepositoryDurable(id);
      else result = await plane.activateRepositoryDurable(id);
      if (!result.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: `repository:${operation}`,
            resourceType: "repository",
            resourceId: id,
            repositoryId: id,
            outcome: "failed",
          }))
        )
          return true;
        send(res, result.code === "NOT_FOUND" ? 404 : 409, {
          error: { code: result.code, message: result.error },
        });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: `repository:${operation}`,
          resourceType: "repository",
          resourceId: id,
          repositoryId: id,
        }))
      )
        return true;
      send(res, 200, result.repository);
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: `repository:${operation}`,
          resourceType: "repository",
          resourceId: id,
          repositoryId: id,
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
    }
    return true;
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
      const updateAudit = {
        action: "repository:update",
        resourceType: "repository",
        resourceId: id,
        repositoryId: id,
      } as const;
      const parsed = await readJsonBodyWithAudit(ctx, { ...updateAudit, outcome: "failed" });
      if (!parsed.ok) return true;
      const bodyError = repositoryMutationBodyError(parsed.body, "update");
      if (bodyError) {
        if (!(await writeRouteAudit(ctx, { ...updateAudit, outcome: "failed" }))) return true;
        sendRouteError(res, 400, "VALIDATION_ERROR", bodyError);
        return true;
      }
      const body = parsed.body as Record<string, unknown>;
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
          const { status, code } = repositoryUpdateError(result.error);
          send(res, status, { error: { code, message: result.error } });
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
      sendListPage(
        ctx,
        (await plane.listSchedulesDurable())
          .filter((schedule) => scoped(ctx, schedule.repositoryId))
          .map(publicSchedule),
        (schedule) => schedule.id,
      );
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
        (typeof body.repositoryId !== "string" && body.repositoryId !== null) ||
        typeof body.name !== "string" ||
        typeof body.target !== "object" ||
        body.target === null ||
        typeof body.cron !== "string" ||
        typeof body.timeout !== "number"
      ) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: "repositoryId (or null), name, target, cron, and timeout are required",
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
      const workspaceError = workspaceScheduleBodyInvalid(body);
      if (workspaceError) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: workspaceError } });
        return true;
      }
      if (
        !canAuthorSessions(ctx) ||
        !scoped(ctx, body.repositoryId === null ? "" : body.repositoryId)
      ) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "schedule:create",
            resourceType: "schedule",
            resourceId: "new",
            ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
            outcome: "denied",
          }))
        )
          return true;
        hidden(res);
        return true;
      }
      if (!cleanupOverrideAllowed(ctx, body)) {
        send(res, 403, {
          error: { code: "FORBIDDEN", message: "fleet:exec-config capability is required" },
        });
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
        repositoryId: body.repositoryId as string | null,
        principalId: ctx.principal?.id ?? SYSTEM_AUDIT_ACTOR.id,
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
        ...(typeof body.workspacePoolId === "string"
          ? { workspacePoolId: body.workspacePoolId }
          : {}),
        ...(typeof body.setupProfileId === "string" || body.setupProfileId === null
          ? { setupProfileId: body.setupProfileId }
          : {}),
        ...(typeof body.destroyWorkspaceAfter === "boolean" || body.destroyWorkspaceAfter === null
          ? { destroyWorkspaceAfter: body.destroyWorkspaceAfter }
          : {}),
        ...(body.requiredLabels !== undefined ? { requiredLabels: body.requiredLabels } : {}),
        ...(body.setupScript !== undefined ? { setupScript: body.setupScript } : {}),
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
            ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
            outcome: "failed",
          }))
        )
          return true;
        const admissionClosed = result.code === "REPOSITORY_ADMISSION_CLOSED";
        send(res, admissionClosed ? 409 : 400, {
          error: {
            code: admissionClosed ? "REPOSITORY_ADMISSION_CLOSED" : "VALIDATION_ERROR",
            message: result.error,
          },
        });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "schedule:create",
          resourceType: "schedule",
          resourceId: result.schedule.id,
          ...(result.schedule.repositoryId ? { repositoryId: result.schedule.repositoryId } : {}),
        }))
      )
        return true;
      send(res, 201, publicSchedule(result.schedule));
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
          action:
            result.code === "DRAINING" ? "session-drain:admission-rejected" : "schedule:trigger",
          resourceType: "schedule",
          resourceId: schedTrigger[1]!,
          ...(triggerExisting?.repositoryId ? { repositoryId: triggerExisting.repositoryId } : {}),
          outcome: "failed",
          ...(result.operationId ? { metadata: { operationId: result.operationId } } : {}),
        }))
      )
        return true;
      const mapped =
        result.code === "DRAINING"
          ? { status: 409, code: "DRAINING" }
          : scheduleTriggerError(result.error);
      send(res, mapped.status, {
        error: {
          code: mapped.code,
          message: result.error,
          ...(result.operationId
            ? {
                operationId: result.operationId,
                statusUrl: `/api/v1/repositories/${encodeURIComponent(triggerExisting!.repositoryId)}/session-drains/${encodeURIComponent(result.operationId)}`,
              }
            : {}),
        },
      });
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
      send(res, 200, publicSchedule(s));
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
        if (
          body.repositoryId !== undefined &&
          body.repositoryId !== null &&
          typeof body.repositoryId !== "string"
        ) {
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: "repositoryId must be a string or null" },
          });
          return true;
        }
        // A repository schedule can carry a branch ref.  Converting it to a
        // workspace schedule deliberately drops that inherited repository-only
        // field; an explicitly supplied ref still receives the normal
        // workspace validation error below.
        const workspacePatch = {
          ...existing,
          ...body,
          repositoryId: body.repositoryId !== undefined ? body.repositoryId : existing.repositoryId,
          ...(body.repositoryId === null && body.ref === undefined ? { ref: undefined } : {}),
        };
        const workspaceError = workspaceScheduleBodyInvalid(workspacePatch);
        if (workspaceError) {
          send(res, 400, { error: { code: "VALIDATION_ERROR", message: workspaceError } });
          return true;
        }
        const destinationRepositoryId =
          workspacePatch.repositoryId === null || workspacePatch.repositoryId === ""
            ? ""
            : workspacePatch.repositoryId;
        if (!scoped(ctx, destinationRepositoryId)) {
          hidden(res);
          return true;
        }
        if (!cleanupOverrideAllowed(ctx, body)) {
          send(res, 403, {
            error: { code: "FORBIDDEN", message: "fleet:exec-config capability is required" },
          });
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
          ...(body.repositoryId === null
            ? { repositoryId: null }
            : typeof body.repositoryId === "string"
              ? { repositoryId: body.repositoryId }
              : {}),
          ...(typeof body.workspacePoolId === "string"
            ? { workspacePoolId: body.workspacePoolId }
            : {}),
          ...(typeof body.setupProfileId === "string" || body.setupProfileId === null
            ? { setupProfileId: body.setupProfileId }
            : {}),
          ...(typeof body.destroyWorkspaceAfter === "boolean" || body.destroyWorkspaceAfter === null
            ? { destroyWorkspaceAfter: body.destroyWorkspaceAfter }
            : {}),
          ...(body.requiredLabels !== undefined ? { requiredLabels: body.requiredLabels } : {}),
          ...(body.setupScript !== undefined ? { setupScript: body.setupScript } : {}),
          ...(typeof body.concurrencyId === "string" ? { concurrencyId: body.concurrencyId } : {}),
          ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
          ...(!existing?.principalId
            ? { principalId: ctx.principal?.id ?? SYSTEM_AUDIT_ACTOR.id }
            : {}),
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
            ...(result.schedule.repositoryId ? { repositoryId: result.schedule.repositoryId } : {}),
          }))
        )
          return true;
        send(res, 200, publicSchedule(result.schedule));
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
