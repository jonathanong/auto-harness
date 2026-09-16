import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessHost } from "./auth-policy.ts";
import { writeRouteAudit } from "./local-audit.ts";

/** Both routes below take the identical `{ hostId }` body — parse and validate once. */
async function readHostIdBody(ctx: RouteCtx): Promise<{ hostId: string } | undefined> {
  const { req, res } = ctx;
  let body: { hostId?: string };
  try {
    body = (await readJson(req)) as { hostId?: string };
  } catch {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
    return undefined;
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.hostId !== "string" ||
    !body.hostId
  ) {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "hostId required" } });
    return undefined;
  }
  return { hostId: body.hostId };
}

/**
 * Same guard drain and resume both use: a repository-scoped principal that
 * isn't bound to this exact host 404s rather than 403s, so an out-of-scope
 * caller can't tell the host exists at all.
 */
function mayOperateHost(ctx: RouteCtx, hostId: string): boolean {
  return (
    mayAccessHost(ctx.principal, hostId) &&
    !(ctx.principal?.allowedRepositoryIds?.length && !ctx.principal.boundHostId)
  );
}

/** POST /api/v1/hosts/drain — mark a host draining; no new assigns until it resumes. */
export async function handleHostDrainRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;

  if (method === "POST" && url.pathname === "/api/v1/hosts/drain") {
    const body = await readHostIdBody(ctx);
    if (!body) return true;
    try {
      if (!mayOperateHost(ctx, body.hostId)) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
        return true;
      }
      const drained = await plane.drainHostDurable(body.hostId);
      if (!drained.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "host:drain",
            resourceType: "host",
            resourceId: body.hostId,
            outcome: "failed",
          }))
        )
          return true;
        send(res, 409, {
          error: { code: "CONFLICT", message: "host connection changed while draining" },
        });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "host:drain",
          resourceType: "host",
          resourceId: body.hostId,
          metadata: { runningSessions: drained.runningSessionIds.length },
        }))
      )
        return true;
      send(res, 200, drained);
      return true;
    } catch (error) {
      sendInternalError(res, { error, method, url, msg: "host-drain route failure" });
      return true;
    }
  }

  // Inverse of drain above: clears the durable `draining` flag and tells the
  // daemon to call resumeFromDrain(). A host that isn't draining is a no-op
  // (200, ok: true) — an operator retrying, or racing the daemon's own
  // reconnect clearing it, is not an error condition.
  if (method === "POST" && url.pathname === "/api/v1/hosts/resume") {
    const body = await readHostIdBody(ctx);
    if (!body) return true;
    try {
      if (!mayOperateHost(ctx, body.hostId)) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
        return true;
      }
      const resumed = await plane.resumeHostDurable(body.hostId);
      if (!resumed.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "host:resume",
            resourceType: "host",
            resourceId: body.hostId,
            outcome: "failed",
          }))
        )
          return true;
        send(res, 409, {
          error: { code: "CONFLICT", message: "host connection changed while resuming" },
        });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "host:resume",
          resourceType: "host",
          resourceId: body.hostId,
        }))
      )
        return true;
      send(res, 200, resumed);
      return true;
    } catch (error) {
      sendInternalError(res, { error, method, url, msg: "host-drain route failure" });
      return true;
    }
  }

  return false;
}
