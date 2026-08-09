import type { HostToServerMessage } from "@auto-harness/shared";

import { readJson, send, type RouteCtx } from "./local-http.ts";
import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import { parseHostMessage } from "./ws-hub.ts";

/** Hosts, worktrees, profiles, host messages, and scheduler routes. */
export async function handleHostSchedulerRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/hosts") {
    send(res, 200, {
      items: plane
        .listHosts()
        .filter(
          (host) =>
            mayAccessHost(ctx.principal, host.hostId) &&
            (!ctx.principal?.allowedRepositoryIds ||
              host.worktreeIds.some((id) =>
                mayAccessRepository(ctx.principal, plane.getWorktree(id)?.repositoryId),
              )),
        ),
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/command-profiles") {
    send(res, 200, { items: plane.listCommandProfiles() });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/worktrees") {
    send(res, 200, {
      items: plane
        .listWorktrees()
        .filter(
          (worktree) =>
            mayAccessHost(ctx.principal, worktree.hostId) &&
            (!ctx.principal || mayAccessRepository(ctx.principal, worktree.repositoryId)),
        ),
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/host/messages") {
    try {
      const body = parseHostMessage(await readJson(req));
      if (!body) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid host message" },
        });
        return true;
      }
      const result = plane.handleHostMessage(body as HostToServerMessage);
      if (!result.ok) {
        send(res, 400, {
          error: { code: "AGENT_MESSAGE_ERROR", message: result.error },
        });
        return true;
      }
      send(res, 200, { ok: true });
      return true;
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
      return true;
    }
  }

  if (method === "POST" && url.pathname === "/api/v1/scheduler/assign") {
    const assigned = plane.assignQueued();
    send(res, 200, {
      items: assigned.map((a) => ({
        sessionId: a.session.id,
        worktreeId: a.worktree.id,
        hostId: a.worktree.hostId,
      })),
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/scheduler/ack-deadlines") {
    const requeued = plane.enforceAckDeadlines();
    send(res, 200, { requeued });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/scheduler/reclaim-stale") {
    const reclaimed = plane.reclaimStaleHosts();
    send(res, 200, { reclaimed });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/scheduler/cron") {
    const created = plane.evaluateCron();
    send(res, 200, { items: created });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/hosts/drain") {
    try {
      const body = (await readJson(req)) as { hostId?: string };
      if (!body.hostId) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "hostId required" },
        });
        return true;
      }
      if (!mayAccessHost(ctx.principal, body.hostId)) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
        return true;
      }
      send(res, 200, plane.drainHost(body.hostId));
      return true;
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
      return true;
    }
  }

  return false;
}
