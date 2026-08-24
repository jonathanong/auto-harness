import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { BASE_COMMAND_ID, seedBaseCommand } from "./control-plane-test-helpers.ts";

function markHostReady(plane: ControlPlane, hostId: string): void {
  const connectionId = `${hostId}-connection`;
  plane.state.connections.set(connectionId, {
    connectionId,
    type: "host",
    hostId,
    connectedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    capabilities: [],
    commandProfiles: [],
    repositoryIds: ["repo-1"],
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    protocolVersion: 1,
  });
  plane.state.hostConnection.set(hostId, connectionId);
}

describe("ControlPlane coverage: bound sessions pin and offline claim", () => {
  it("bound sessions pin and offline claim", () => {
    const planeE = new ControlPlane({
      idFactory: () => "e1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(planeE);
    markHostReady(planeE, "ae");
    planeE.seedWorktree({
      id: "we",
      name: "we",
      hostId: "ae",
      repositoryId: "repo-1",
      path: "/e",
      labels: [],
      status: "idle",
      online: true,
    });
    planeE.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const es = planeE.state.sessions.get("e1")!;
    es.hostId = "ae";
    es.worktreeId = "we";
    es.ackReceivedAt = "t";
    expect(planeE.assignQueued()).toHaveLength(0);

    // resume without cliResumeRef branch + early ack deadline continue
    const planeF = new ControlPlane({
      idFactory: (() => {
        let i = 0;
        return () => `f${++i}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      ackDeadlineMs: 60_000,
    });
    seedBaseCommand(planeF);
    markHostReady(planeF, "af");
    planeF.seedWorktree({
      id: "wf",
      name: "wf",
      hostId: "af",
      repositoryId: "repo-1",
      path: "/f",
      labels: [],
      status: "idle",
      online: true,
    });
    planeF.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
      ref: "main",
    });
    planeF.assignQueued();
    const first = planeF.getSession("f1")!;
    planeF.handleHostMessage({
      type: "session:ack",
      sessionId: "f1",
      worktreeId: first.worktreeId!,
      attemptId: first.attemptId!,
    });
    planeF.handleHostMessage({
      type: "session:status",
      sessionId: "f1",
      worktreeId: first.worktreeId!,
      attemptId: first.attemptId!,
      status: "completed",
    });
    // force agent pin without cliResumeRef
    planeF.state.sessions.get("f1")!.hostId = "af";
    delete planeF.state.sessions.get("f1")!.cliResumeRef;
    const resF = planeF.resumeSession("f1");
    expect(resF.ok).toBe(true);
    planeF.seedWorktree({
      id: "wf2",
      name: "wf2",
      hostId: "af",
      repositoryId: "repo-1",
      path: "/f2",
      labels: [],
      status: "idle",
      online: true,
    });
    expect(planeF.assignQueued().length).toBeGreaterThan(0);
    // deadline not expired: call with now equal to assignment time (fixed clock)
    const assignMs = Date.parse("2026-01-01T00:00:00.000Z");
    planeF.state.pendingAcks.set("pending-early", {
      sessionId: "x",
      worktreeId: "wf2",
      attemptId: "attempt-early",
      assignedAtMs: assignMs,
    });
    expect(planeF.enforceAckDeadlines(assignMs)).toEqual([]);

    // tryClaim false: get returns offline worktree
    const planeG = new ControlPlane({
      idFactory: () => "g1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(planeG);
    markHostReady(planeG, "ag");
    planeG.seedWorktree({
      id: "wg",
      name: "wg",
      hostId: "ag",
      repositoryId: "repo-1",
      path: "/g",
      labels: [],
      status: "idle",
      online: true,
    });
    planeG.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const gMap = planeG.state.worktrees;
    const realGet = gMap.get.bind(gMap);
    gMap.get = (id: string) => {
      const w = realGet(id);
      if (w) {
        return { ...w, online: false };
      }
      return w;
    };
    expect(planeG.assignQueued()).toHaveLength(0);
  });
});
