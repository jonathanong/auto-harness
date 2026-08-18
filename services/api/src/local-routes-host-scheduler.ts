import type { HostToServerMessage } from "@auto-harness/shared";

import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import { parseHostMessage } from "./ws-hub.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { handleSchedulerRoutes } from "./local-routes-scheduler.ts";

/**
 * The only three variants carrying `hostId` instead of `sessionId` — kept as one predicate
 * so every call site narrows the same way; a `.startsWith("host:")` string check (the
 * previous approach in the audit calls below) happens to classify these identically but
 * isn't a real discriminant, so a future new "host:*" variant could silently fall through
 * the wrong branch here without TypeScript ever catching it.
 */
function isHostScopedMessage(
  msg: HostToServerMessage,
): msg is Extract<HostToServerMessage, { hostId: string }> {
  return (
    msg.type === "host:register" || msg.type === "host:status" || msg.type === "host:keepalive"
  );
}

/** Hosts, worktrees, profiles, host messages, and scheduler routes. */
export async function handleHostSchedulerRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (await handleSchedulerRoutes(ctx)) return true;

  if (method === "GET" && url.pathname === "/api/v1/hosts") {
    try {
      send(res, 200, {
        items: (await plane.listHostsDurable()).filter(
          (host) =>
            mayAccessHost(ctx.principal, host.hostId) &&
            (!ctx.principal?.allowedRepositoryIds ||
              host.repositoryIds.some((id) => mayAccessRepository(ctx.principal, id)) ||
              host.worktreeIds.some((id) =>
                mayAccessRepository(ctx.principal, plane.getWorktree(id)?.repositoryId),
              )),
        ),
      });
    } catch {
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/worktrees") {
    try {
      send(res, 200, {
        items: (await plane.listWorktreesDurable()).filter(
          (worktree) =>
            mayAccessHost(ctx.principal, worktree.hostId) &&
            (!ctx.principal || mayAccessRepository(ctx.principal, worktree.repositoryId)),
        ),
      });
    } catch {
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/host/messages") {
    let rawBody: unknown;
    try {
      rawBody = await readJson(req);
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    const body = parseHostMessage(rawBody);
    if (!body) {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid host message" } });
      return true;
    }
    try {
      if (isHostScopedMessage(body)) {
        if (!mayAccessHost(ctx.principal, body.hostId)) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
          return true;
        }
      } else if (ctx.principal?.boundHostId) {
        const session = plane.getSession(body.sessionId);
        if (!session || !mayAccessHost(ctx.principal, session.hostId ?? undefined)) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
          return true;
        }
      }
      // ACK/status/log transitions require the WebSocket connection epoch.
      // The legacy HTTP relay has no durable per-connection fence, so keeping
      // it writable would let a superseded host mutate a replacement lease.
      if (
        body.type === "session:ack" ||
        body.type === "session:status" ||
        body.type === "session:log" ||
        body.type === "session:usage"
      ) {
        send(res, 410, {
          error: { code: "HOST_MESSAGE_WEBSOCKET_REQUIRED", message: "use the host WebSocket" },
        });
        return true;
      }
      // Every session:* variant returned above, so only host:register/host:status/
      // host:keepalive can reach here — body is always host-scoped from this point on.
      const result = await plane.handleHostMessageDurable(body);
      if (!result.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "host:message",
            resourceType: "host",
            resourceId: body.hostId,
            outcome: "failed",
            metadata: { type: body.type },
          }))
        )
          return true;
        const missing = result.error === "session not found";
        const conflict = /stale|changed|fence|connection/i.test(result.error);
        send(res, missing ? 404 : conflict ? 409 : 400, {
          error: {
            code: missing ? "NOT_FOUND" : conflict ? "CONFLICT" : "AGENT_MESSAGE_ERROR",
            message: result.error,
          },
        });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "host:message",
          resourceType: "host",
          resourceId: body.hostId,
          metadata: { type: body.type },
        }))
      )
        return true;
      send(res, 200, { ok: true });
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }

  if (method === "POST" && url.pathname === "/api/v1/hosts/drain") {
    let body: { hostId?: string };
    try {
      body = (await readJson(req)) as { hostId?: string };
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.hostId !== "string" ||
      !body.hostId
    ) {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "hostId required" } });
      return true;
    }
    try {
      if (!mayAccessHost(ctx.principal, body.hostId)) {
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
    } catch {
      sendInternalError(res);
      return true;
    }
  }

  return false;
}
