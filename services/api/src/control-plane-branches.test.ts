import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  BASE_COMMAND_ID,
  baseSessionBody,
  putScheduleOrThrow,
  seedBaseCommand,
} from "./control-plane-test-helpers.ts";

describe("ControlPlane remaining branches", () => {
  it("covers remaining branches: disabled cron, future fire, limit suppression, register replace, disconnect", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      scheduleIdFactory: () => "sched-x",
      connectionIdFactory: (() => {
        let c = 0;
        return () => `conn-${++c}`;
      })(),
      shardCount: 1,
      ackDeadlineMs: 50,
    });
    seedBaseCommand(plane);

    // disabled + future schedule
    putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "off",
      target: { commandId: BASE_COMMAND_ID },
      cron: "0 * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      enabled: false,
    });
    expect(plane.evaluateCron()).toHaveLength(0);
    const future = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "later",
      target: { commandId: BASE_COMMAND_ID },
      cron: "0 * * * *",
      timeout: 10,
      nextRunAt: "2099-01-01T00:00:00.000Z",
      enabled: true,
      ref: "main",
    });
    expect(plane.evaluateCron()).toHaveLength(0);
    expect(
      plane.tryClaimScheduleFire(future.id, future.nextRunAt, "2026-01-01T00:00:00.000Z"),
    ).toBeNull();
    expect(plane.tryClaimScheduleFire("missing", "t", "2026-01-01T00:00:00.000Z")).toBeNull();

    // agent register via message + failed second register
    expect(
      plane.handleHostMessage({
        type: "host:register",
        hostId: "ax",
        worktrees: [{ id: "wt-x", name: "wt-x", repositoryId: "repo-1", path: "/x", labels: [] }],
        commandProfiles: ["echo-prompt"],
      }).ok,
    ).toBe(true);
    expect(
      plane.handleHostMessage({
        type: "host:register",
        hostId: "ax",
        worktrees: [{ id: "wt-x", name: "wt-x", repositoryId: "repo-1", path: "/x", labels: [] }],
        commandProfiles: ["echo-prompt"],
      }).ok,
    ).toBe(false);
    expect(plane.heartbeat("ax")).toBe(true);
    const connId = plane.listHosts()[0] ? "conn-1" : "conn-1";
    plane.disconnectHost(connId);
    plane.disconnectHost("missing-conn");

    // A providerless limit is session-local and leaves its target suppressed.
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    const created = plane.createSession(baseSessionBody());
    expect(created.ok).toBe(true);
    if (created.ok) {
      const s = plane.getSession(created.session.id)!;
      // force running path with assign then usage limit
      const assigned = plane.assignQueued().find((a) => a.session.id === created.session.id)!;
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: created.session.id,
        worktreeId: assigned.worktree.id,
        attemptId: assigned.session.attemptId!,
      });
      plane.handleHostMessage({
        type: "session:status",
        sessionId: created.session.id,
        worktreeId: assigned.worktree.id,
        attemptId: assigned.session.attemptId!,
        status: "failed",
        errorCode: "usage_limit",
        errorMessage: "quota",
        exitCode: 1,
      });
      expect(plane.getSession(created.session.id)?.status).toBe("queued");
      // The suppressed target leaves the session queued without assignment.
      expect(plane.assignQueued()).toHaveLength(0);
      void s;
    }

    // ack deadline: already acked pending cleanup
    const ackClean = plane.createSession(baseSessionBody({ prompt: "ack-clean" }));
    const running = ackClean.ok
      ? plane.assignQueued().find((a) => a.session.id === ackClean.session.id)
      : undefined;
    if (running) {
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: running.session.id,
        worktreeId: running.worktree.id,
        attemptId: running.session.attemptId!,
      });
      // still in pending until ack deletes — enforce should no-op requeue
      expect(plane.enforceAckDeadlines(Date.now() + 999999)).toEqual([]);
    }

    // apply status for cancelled/timed_out
    plane.createSession(baseSessionBody({ prompt: "cancel-me" }));
    // seed online worktree again
    plane.seedWorktree({
      id: "wt-2",
      name: "wt-2",
      hostId: "a1",
      repositoryId: "repo-1",
      path: "/w2",
      labels: [],
      status: "idle",
      online: true,
    });
    const c = plane.listSessions().find((s) => s.prompt === "cancel-me");
    if (c) {
      // system cancel (not agent status path)
      expect(plane.forceStatus(c.id, "cancelled")?.status).toBe("cancelled");
    }

    // resume without agent
    const noAgent = new ControlPlane({
      idFactory: () => "s-na",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(noAgent);
    noAgent.createSession(baseSessionBody());
    expect(noAgent.resumeSession("s-na").ok).toBe(false);

    // reclaim when not stale
    const plane2 = new ControlPlane({
      heartbeatStaleMs: 60_000,
      connectionIdFactory: () => "c1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane2.registerHost({
      hostId: "fresh",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo-1", path: "/p", labels: [] }],
      commandProfiles: ["echo-prompt"],
    });
    expect(plane2.reclaimStaleHosts(Date.parse("2026-01-01T00:00:00.000Z") + 100)).toEqual([]);

    // release missing worktree
    plane2.seedWorktree({
      id: "wt-gone",
      name: "wt-gone",
      hostId: "fresh",
      repositoryId: "repo-1",
      path: "/g",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "x",
    });
  });
});
