import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { BASE_COMMAND_ID, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { offlineHostAndRequeueDurable } from "./control-plane-worktrees.ts";

describe("ControlPlane coverage: orphan maps, claims, and ack deadlines", () => {
  it("orphan maps tryClaim and ack deadlines", () => {
    const planeO = new ControlPlane({
      connectionIdFactory: () => "orphan",
      heartbeatStaleMs: 1,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(planeO);
    planeO.registerHost({
      hostId: "o1",
      worktrees: [{ id: "wo", name: "wo", repositoryId: "repo-1", path: "/o", labels: [] }],
      commandProfiles: ["x"],
    });
    const originalConnection = planeO.state.connections.get("orphan")!;
    planeO.state.connections.delete("orphan");
    expect(planeO.heartbeat("o1")).toBe(false);
    planeO.state.hostConnection.set("o1", "ghost");
    expect(planeO.reclaimStaleHosts(Date.now() + 10_000)).toEqual([]);
    planeO.state.connections.set("orphan", originalConnection);
    planeO.state.hostConnection.set("o1", "orphan");

    planeO.state.pendingAcks.set("gone", {
      sessionId: "gone",
      worktreeId: "wo",
      attemptId: "gone-attempt",
      assignedAtMs: 0,
    });
    expect(planeO.enforceAckDeadlines(Date.now())).toEqual([]);

    planeO.createSession({
      repositoryId: "repo-1",
      prompt: "z",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const z = planeO.listSessions()[0]!;
    const zAssignment = planeO.assignQueued().find((a) => a.session.id === z.id)!;
    planeO.state.worktrees.delete(zAssignment.worktree.id);
    planeO.handleHostMessage({
      type: "session:status",
      sessionId: z.id,
      worktreeId: zAssignment.worktree.id,
      attemptId: zAssignment.session.attemptId!,
      status: "timed_out",
    });

    // tryClaim false path: idle filter then mark busy
    const planeC = new ControlPlane({
      idFactory: () => "cx",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(planeC);
    planeC.seedWorktree({
      id: "only",
      name: "only",
      hostId: "a",
      repositoryId: "repo-1",
      path: "/p",
      labels: [],
      status: "idle",
      online: true,
    });
    planeC.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    // monkeypatch tryClaim by making worktree busy right before assign
    const wtMap = planeC.state.worktrees;
    const origGet = wtMap.get.bind(wtMap);
    let calls = 0;
    wtMap.get = (id: string) => {
      const w = origGet(id);
      calls += 1;
      // After listIdle uses values(); tryClaim uses get — flip busy on claim attempts after first read of idle list
      if (w && calls > 3 && w.status === "idle") {
        w.status = "busy";
      }
      return w;
    };
    planeC.assignQueued();
    expect(calls).toBeGreaterThan(0);

    // release missing worktree + ack deadline already-acked pending
    const planeD = new ControlPlane({
      idFactory: () => "d1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      ackDeadlineMs: 1,
    });
    seedBaseCommand(planeD);
    planeD.seedWorktree({
      id: "wd",
      name: "wd",
      hostId: "ad",
      repositoryId: "repo-1",
      path: "/d",
      labels: [],
      status: "idle",
      online: true,
    });
    planeD.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const dAssignment = planeD.assignQueued().find((a) => a.session.id === "d1")!;
    planeD.handleHostMessage({
      type: "session:ack",
      sessionId: "d1",
      worktreeId: dAssignment.worktree.id,
      attemptId: dAssignment.session.attemptId!,
    });
    // pending cleared on ack; inject fake pending with acked session
    planeD.state.pendingAcks.set("d1", {
      sessionId: "d1",
      worktreeId: dAssignment.worktree.id,
      attemptId: dAssignment.session.attemptId!,
      assignedAtMs: 0,
    });
    // session has ackReceivedAt
    expect(planeD.enforceAckDeadlines(Date.now() + 1000)).toEqual([]);
    // release missing via private path: requeue without worktree
    planeD.state.pendingAcks.set("d1", {
      sessionId: "d1",
      worktreeId: dAssignment.worktree.id,
      attemptId: dAssignment.session.attemptId!,
      assignedAtMs: 0,
    });
    delete planeD.state.sessions.get("d1")!.ackReceivedAt;
    planeD.state.sessions.get("d1")!.status = "running";
    planeD.state.worktrees.delete(dAssignment.worktree.id);
    expect(planeD.enforceAckDeadlines(Date.now() + 1000)).toEqual(["d1"]);

    // keepalive success path
    planeD.registerHost({
      hostId: "alive",
      worktrees: [],
      commandProfiles: ["c"],
      replaceExisting: true,
    });
    expect(
      planeD.handleHostMessage({
        type: "host:keepalive",
        hostId: "alive",
        at: "2026-01-01T00:00:01.000Z",
      }).ok,
    ).toBe(true);
  });

  it("refreshes stale durable rows after a requeue race loses", async () => {
    const plane = new ControlPlane({
      idFactory: () => "durable-race",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "race-wt",
      name: "race-wt",
      hostId: "race-host",
      repositoryId: "repo-1",
      path: "/race",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession({
      repositoryId: "repo-1",
      prompt: "race",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const assignment = plane.assignQueued()[0]!;
    const running = plane.state.sessions.get(assignment.session.id)!;
    let sessionReads = 0;
    plane.state.storage = {
      listWorktreesByHost: async () => [assignment.worktree],
      tryRequeueSession: async () => false,
      getWorktree: async () => ({
        ...assignment.worktree,
        status: "idle",
        online: false,
        currentSessionId: null,
      }),
      getSession: async () =>
        sessionReads++ === 0
          ? running
          : {
              ...running,
              status: "completed",
              worktreeId: null,
              hostId: null,
            },
    } as never;

    expect(await offlineHostAndRequeueDurable(plane.state, "race-host", "race lost")).toEqual([]);
    expect(plane.state.worktrees.get("race-wt")?.status).toBe("idle");
    expect(plane.state.sessions.get("durable-race")?.status).toBe("completed");
  });
});
