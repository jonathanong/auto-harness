import type { HostToServerMessage } from "@auto-harness/shared";

import { readJson, send, type RouteCtx } from "./local-http.ts";

/** Agents, worktrees, profiles, agent messages, and scheduler routes. */
export async function handleAgentSchedulerRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/agents") {
    send(res, 200, { items: plane.listAgents() });
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
      const result = plane.handleAgentMessage(body);
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
        agentId: a.worktree.agentId,
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
    const reclaimed = plane.reclaimStaleAgents();
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
      const body = (await readJson(req)) as { agentId?: string };
      if (!body.agentId) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "agentId required" },
        });
        return true;
      }
      send(res, 200, plane.drainAgent(body.agentId));
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
