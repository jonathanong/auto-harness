import { MAX_SESSION_TIMEOUT_SECONDS } from "@auto-harness/shared";

import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import {
  canAccessSession,
  canAccessSessionHost,
  canAuthorSessions,
  sendSessionForbidden,
} from "./local-routes-session-access.ts";

const RESUME_BODY_FIELDS = new Set([
  "prompt",
  "timeout",
  "priority",
  "concurrencyId",
  "target",
  "fallbacks",
]);

function validResumeBody(
  body: Record<string, unknown>,
  sourceConcurrencyId: string | undefined,
): boolean {
  return (
    Object.keys(body).every((key) => RESUME_BODY_FIELDS.has(key)) &&
    (body.prompt === undefined || (typeof body.prompt === "string" && body.prompt.length > 0)) &&
    (body.timeout === undefined ||
      (typeof body.timeout === "number" &&
        Number.isFinite(body.timeout) &&
        body.timeout > 0 &&
        body.timeout <= MAX_SESSION_TIMEOUT_SECONDS)) &&
    (body.priority === undefined ||
      (typeof body.priority === "number" && Number.isFinite(body.priority))) &&
    (body.concurrencyId === undefined ||
      (typeof body.concurrencyId === "string" && body.concurrencyId === sourceConcurrencyId)) &&
    // Coarse shape only — precise routing errors (unknown commandId, malformed
    // target shape, duplicate fallbacks, …) come back from the control plane as
    // a VALIDATION_ERROR with the exact message.
    (body.target === undefined ||
      (typeof body.target === "object" && body.target !== null && !Array.isArray(body.target))) &&
    (body.fallbacks === undefined || Array.isArray(body.fallbacks))
  );
}

export async function handleSessionResumeRoute(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;
  const match = /^\/api\/v1\/sessions\/([^/]+)\/resume$/.exec(url.pathname);
  if (method !== "POST" || !match) return false;
  const id = match[1]!;
  let existing: Awaited<ReturnType<typeof plane.getSessionDurable>>;
  try {
    existing = await plane.getSessionDurable(id);
    if (
      !canAuthorSessions(ctx) ||
      !existing ||
      !canAccessSession(ctx, existing.repositoryId) ||
      !canAccessSessionHost(ctx, existing.hostId)
    ) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "session:resume",
          resourceType: "session",
          resourceId: id,
          ...(existing?.repositoryId ? { repositoryId: existing.repositoryId } : {}),
          outcome: "denied",
        }))
      )
        return true;
      sendSessionForbidden(res);
      return true;
    }
  } catch {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:resume",
        resourceType: "session",
        resourceId: id,
        outcome: "failed",
      }))
    )
      return true;
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
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:resume",
        resourceType: "session",
        resourceId: id,
        repositoryId: existing.repositoryId,
        outcome: "failed",
      }))
    )
      return true;
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
    return true;
  }
  if (!validResumeBody(body, existing.concurrencyId)) {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:resume",
        resourceType: "session",
        resourceId: id,
        repositoryId: existing.repositoryId,
        outcome: "failed",
      }))
    )
      return true;
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid resume overrides" } });
    return true;
  }
  const retargeted = body.target !== undefined;
  try {
    const result = await plane.resumeSessionDurable(id, {
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
      ...(typeof body.timeout === "number" ? { timeout: body.timeout } : {}),
      ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
      ...(body.target !== undefined ? { target: body.target } : {}),
      ...(body.fallbacks !== undefined ? { fallbacks: body.fallbacks } : {}),
      ...(ctx.principal ? { principalId: ctx.principal.id } : {}),
    });
    if (!result.ok) {
      if (
        !(await writeRouteAudit(ctx, {
          action:
            result.code === "DRAINING" ? "session-drain:admission-rejected" : "session:resume",
          resourceType: "session",
          resourceId: id,
          repositoryId: existing.repositoryId,
          outcome: result.code === "FORBIDDEN" ? "denied" : "failed",
          ...(result.operationId ? { metadata: { operationId: result.operationId } } : {}),
        }))
      )
        return true;
      const missing = result.error === "session not found";
      const admissionClosed = result.code === "REPOSITORY_ADMISSION_CLOSED";
      const draining = result.code === "DRAINING";
      const forbidden = result.code === "FORBIDDEN";
      const conflict =
        admissionClosed ||
        draining ||
        existing.type === "scheduled" ||
        /already terminal|must be terminal|no agent|conflicted|changed before/i.test(result.error);
      let code = "VALIDATION_ERROR";
      if (conflict) code = "CONFLICT";
      if (admissionClosed) code = "REPOSITORY_ADMISSION_CLOSED";
      if (draining) code = "DRAINING";
      if (missing) code = "NOT_FOUND";
      if (forbidden) code = "FORBIDDEN";
      send(res, missing ? 404 : forbidden ? 403 : conflict ? 409 : 400, {
        error: {
          code,
          message: result.error,
          ...(result.operationId
            ? {
                operationId: result.operationId,
                statusUrl: `/api/v1/repositories/${encodeURIComponent(existing.repositoryId)}/session-drains/${encodeURIComponent(result.operationId)}`,
              }
            : {}),
        },
      });
      return true;
    }
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:resume",
        resourceType: "session",
        resourceId: result.session.id,
        repositoryId: result.session.repositoryId,
        metadata: { created: result.created, ...(retargeted ? { retargeted: true } : {}) },
      }))
    )
      return true;
    await plane.requestAssignment();
    send(res, result.created ? 201 : 200, { ...result.session, created: result.created });
  } catch {
    if (
      !(await writeRouteAudit(ctx, {
        action: "session:resume",
        resourceType: "session",
        resourceId: id,
        repositoryId: existing.repositoryId,
        outcome: "failed",
      }))
    )
      return true;
    sendInternalError(res);
  }
  return true;
}
