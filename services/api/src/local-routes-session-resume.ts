import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { canAccessSession, sendSessionForbidden } from "./local-routes-session-access.ts";

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

export async function handleSessionResumeRoute(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;
  const match = /^\/api\/v1\/sessions\/([^/]+)\/resume$/.exec(url.pathname);
  if (method !== "POST" || !match) return false;
  const id = match[1]!;
  let existing: Awaited<ReturnType<typeof plane.getSessionDurable>>;
  try {
    existing = await plane.getSessionDurable(id);
    if (!existing || !canAccessSession(ctx, existing.repositoryId)) {
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
  if (!validResumeBody(body)) {
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
  try {
    const result = await plane.resumeSessionDurable(id, {
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
      ...(typeof body.timeout === "number" ? { timeout: body.timeout } : {}),
      ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
    });
    if (!result.ok) {
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
      const missing = result.error === "session not found";
      const conflict =
        existing.type === "scheduled" ||
        /already terminal|must be terminal|no agent|conflicted|changed before/i.test(result.error);
      send(res, missing ? 404 : conflict ? 409 : 400, {
        error: {
          code: missing ? "NOT_FOUND" : conflict ? "CONFLICT" : "VALIDATION_ERROR",
          message: result.error,
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
        metadata: { created: result.created },
      }))
    )
      return true;
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
