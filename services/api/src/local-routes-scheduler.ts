import { writeSystemAudit } from "./local-audit.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { assignQueuedAndScheduledDurable } from "./request-assignment.ts";

export async function handleSchedulerRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  if (method === "POST" && url.pathname === "/api/v1/scheduler/assign") {
    try {
      const assignments = await assignQueuedAndScheduledDurable(plane.state);
      const assigned = assignments.queuedAssigned;
      const scheduled = assignments.scheduledAssigned;
      if (
        !(await writeSystemAudit(ctx, {
          action: "scheduler:assign",
          resourceType: "scheduler",
          resourceId: "queue",
          metadata: { assigned: assigned.length, scheduled: scheduled.length },
        }))
      )
        return true;
      send(res, 200, {
        items: [
          ...assigned.map((a) => ({
            sessionId: a.session.id,
            worktreeId: a.worktree.id,
            hostId: a.worktree.hostId,
          })),
          ...scheduled.map((a) => ({
            sessionId: a.session.id,
            worktreeId: null,
            hostId: a.hostId,
          })),
        ],
      });
    } catch {
      if (
        await writeSystemAudit(ctx, {
          action: "scheduler:assign",
          resourceType: "scheduler",
          resourceId: "queue",
          outcome: "failed",
        })
      )
        sendInternalError(res);
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/scheduler/ack-deadlines") {
    try {
      const requeued = await plane.enforceAckDeadlinesDurable();
      if (
        !(await writeSystemAudit(ctx, {
          action: "scheduler:ack-deadlines",
          resourceType: "scheduler",
          resourceId: "ack-deadlines",
          metadata: { requeued: requeued.length },
        }))
      )
        return true;
      send(res, 200, { requeued });
    } catch {
      if (
        await writeSystemAudit(ctx, {
          action: "scheduler:ack-deadlines",
          resourceType: "scheduler",
          resourceId: "ack-deadlines",
          outcome: "failed",
        })
      )
        sendInternalError(res);
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/scheduler/reclaim-stale") {
    try {
      const reclaimed = await plane.reclaimStaleHostsDurable();
      if (
        !(await writeSystemAudit(ctx, {
          action: "scheduler:reclaim-stale",
          resourceType: "scheduler",
          resourceId: "stale-hosts",
          metadata: { reclaimed: reclaimed.length },
        }))
      )
        return true;
      send(res, 200, { reclaimed });
    } catch {
      if (
        await writeSystemAudit(ctx, {
          action: "scheduler:reclaim-stale",
          resourceType: "scheduler",
          resourceId: "stale-hosts",
          outcome: "failed",
        })
      )
        sendInternalError(res);
    }
    return true;
  }
  if (method !== "POST" || url.pathname !== "/api/v1/scheduler/cron") return false;
  try {
    const created = await plane.evaluateCronDurable();
    if (
      !(await writeSystemAudit(ctx, {
        action: "scheduler:cron",
        resourceType: "scheduler",
        resourceId: "cron",
        metadata: { created: created.length },
      }))
    )
      return true;
    send(res, 200, { items: created });
  } catch {
    if (
      await writeSystemAudit(ctx, {
        action: "scheduler:cron",
        resourceType: "scheduler",
        resourceId: "cron",
        outcome: "failed",
      })
    )
      sendInternalError(res);
  }
  return true;
}
