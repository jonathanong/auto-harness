import type { HostToServerMessage } from "@auto-harness/shared";

import { readJson, send, type RouteCtx } from "./local-http.ts";

/** Agents, worktrees, profiles, agent messages, and scheduler routes. */
export async function handleAgentSchedulerRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/agents") {
    send(res, 200, { items: plane.listHosts() });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/command-profiles") {
    send(res, 200, { items: plane.listCommandProfiles() });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/worktrees") {
    send(res, 200, { items: plane.listWorktrees() });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/agent/messages") {
    try {
      const body = (await readJson(req)) as HostToServerMessage;
      const result = plane.handleHostMessage(body);
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

  if (method === "POST" && url.pathname === "/api/v1/agents/drain") {
    try {
      const body = (await readJson(req)) as { hostId?: string };
      if (!body.hostId) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "hostId required" },
        });
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
