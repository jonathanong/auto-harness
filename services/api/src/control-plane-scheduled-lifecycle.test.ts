import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { offlineHostAndRequeue } from "./control-plane-worktrees.ts";

function setup(ids = ["s1", "s2"]) {
  let index = 0;
  const sent: unknown[] = [];
  const plane = new ControlPlane({
    idFactory: () => ids[index++]!,
    shardCount: 1,
    onHostMessage: (_host, message) => sent.push(message),
  });
  seedBaseCommand(plane);
  for (const hostId of ["host-a", "host-b"]) {
    plane.registerHost({
      hostId,
      worktrees: [],
      repositories: [{ id: "repo-1", path: `/${hostId}/repo`, defaultBranch: "main" }],
      commandProfiles: [],
      capabilities: ["scheduled-main-checkout"],
    });
  }
  const schedule = putScheduleOrThrow(plane, {
    repositoryId: "repo-1",
    name: "maintenance",
    target: { commandId: "cmd-base" },
    cron: "* * * * *",
    timeout: 30,
    nextRunAt: "2026-01-01T00:00:00.000Z",
  });
  return { plane, schedule, sent };
}

describe("scheduled main-checkout scheduling", () => {
  it("round-robins capable hosts without claiming a worktree", async () => {
    const { plane, schedule, sent } = setup();
    const secondSchedule = putScheduleOrThrow(plane, {
      id: "schedule-second",
      repositoryId: "repo-1",
      name: "second maintenance",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(plane.triggerSchedule(schedule.id).ok).toBe(true);
    expect(plane.triggerSchedule(secondSchedule.id).ok).toBe(true);
    const assigned = await plane.assignScheduledQueuedDurable();
    expect(assigned.map((item) => item.hostId)).toEqual(["host-a", "host-b"]);
    expect(assigned.every((item) => item.worktreeId === null)).toBe(true);
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ worktreeId: null })]));
    expect(plane.listWorktrees()).toEqual([]);
  });

  it("releases the exact lease on terminal, retry, cancel, and unacked disconnect", async () => {
    const { plane } = setup(["completed", "retry", "cancel", "unacked"]);
    for (const status of ["completed", "retry", "cancel", "unacked"] as const) {
      const schedule = putScheduleOrThrow(plane, {
        id: `schedule-${status}`,
        repositoryId: "repo-1",
        name: `${status} maintenance`,
        target: { commandId: "cmd-base" },
        cron: "* * * * *",
        timeout: 30,
        nextRunAt: "2026-01-01T00:00:00.000Z",
      });
      expect(plane.triggerSchedule(schedule.id).ok).toBe(true);
      await plane.assignScheduledQueuedDurable();
      const session = plane.getSession(status)!;
      if (!session.attemptId) throw new Error(`missing attempt for ${status}`);
      const fence = { worktreeId: null, attemptId: session.attemptId } as const;
      if (status === "completed") {
        plane.handleHostMessage({
          type: "session:status",
          sessionId: status,
          status: "completed",
          exitCode: 0,
          ...fence,
        });
        expect(plane.getSession(status)).toMatchObject({
          status: "completed",
          worktreeId: null,
          exitCode: 0,
        });
      } else if (status === "retry") {
        plane.handleHostMessage({
          type: "session:status",
          sessionId: status,
          status: "failed",
          errorCode: "usage_limit",
          ...fence,
        });
        expect(plane.getSession(status)).toMatchObject({ status: "queued", hostId: null });
      } else if (status === "cancel") {
        plane.cancelSession(status);
        plane.handleHostMessage({
          type: "session:status",
          sessionId: status,
          status: "cancelled",
          ...fence,
        });
        expect(plane.getSession(status)?.mainCheckoutLease).toBeUndefined();
      } else {
        expect(offlineHostAndRequeue(plane.state, session.hostId!, "gone")).toContain(status);
        expect(plane.getSession(status)).toMatchObject({ status: "queued", hostId: null });
      }
      for (const field of [
        "mainCheckoutLease",
        "assignmentConnectionId",
        "assignmentSentAt",
        "ackReceivedAt",
        "reconnectDeadlineAt",
      ]) {
        expect(plane.getSession(status)).not.toHaveProperty(field);
      }
    }
  });
});
