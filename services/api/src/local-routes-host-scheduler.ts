import type { HostToServerMessage } from "@auto-harness/shared";

import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessHost } from "./auth-policy.ts";
import { filterUserSessionsForPrincipal } from "./control-plane-user-sessions.ts";
import { parseHostMessage } from "./ws-hub.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { handleSchedulerRoutes } from "./local-routes-scheduler.ts";
import { handleHostReadRoutes } from "./local-routes-hosts.ts";
import { handleWorktreeReadRoutes } from "./local-routes-worktrees.ts";
import { handleHostDrainRoutes } from "./local-routes-host-drain.ts";
import { sendListPage } from "./local-list-page.ts";
import { reportRouteError } from "./route-errors.ts";

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
  if (await handleWorktreeReadRoutes(ctx)) return true;
  if (await handleHostReadRoutes(ctx)) return true;
  if (await handleHostDrainRoutes(ctx)) return true;

  if (method === "GET" && url.pathname === "/api/v1/user-sessions") {
    try {
      sendListPage(
        ctx,
        filterUserSessionsForPrincipal(await plane.listUserSessionsDurable(), ctx.principal),
        (session) => session.id,
      );
    } catch (error) {
      reportRouteError({ error, method, url, msg: "host-scheduler route failure" });
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
        const session = await plane.getSessionDurable(body.sessionId);
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
        body.type === "session:command-start" ||
        body.type === "session:status" ||
        body.type === "session:log" ||
        body.type === "session:usage" ||
        body.type === "session:terminal-hook-complete"
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
        const conflict =
          result.error !== undefined && /stale|changed|fence|connection/i.test(result.error);
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
      if (body.type === "host:register") await plane.enqueueAssignment();
      send(res, 200, { ok: true });
      return true;
    } catch (error) {
      sendInternalError(res, { error, method, url, msg: "host-scheduler route failure" });
      return true;
    }
  }

  return false;
}
