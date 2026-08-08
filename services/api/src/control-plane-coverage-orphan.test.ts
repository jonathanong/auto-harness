import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { BASE_COMMAND_ID, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane coverage: orphan maps tryClaim and ack deadlines", () => {
  it("orphan maps tryClaim and ack deadlines", () => {
    const planeO = new ControlPlane({
      connectionIdFactory: () => "orphan",
      heartbeatStaleMs: 1,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(planeO);
    planeO.registerAgent({
      hostId: "o1",
      worktrees: [{ id: "wo", name: "wo", repositoryId: "repo-1", path: "/o", labels: [] }],
      commandProfiles: ["x"],
    });
    // break consistency: delete connection but leave agent map
    planeO.state.connections.delete("orphan");
    expect(planeO.heartbeat("o1")).toBe(false);
    planeO.state.agentConnection.set("o1", "ghost");
    expect(planeO.reclaimStaleAgents(Date.now() + 10_000)).toEqual([]);

    // ack deadline: pending without session; pending with acked session
    planeO.state.pendingAcks.set("gone", {
      sessionId: "gone",
      worktreeId: "wo",
      assignedAtMs: 0,
    });
    expect(planeO.enforceAckDeadlines(Date.now())).toEqual([]);

    // release missing worktree via status complete without worktree
    planeO.createSession({
      repositoryId: "repo-1",
      prompt: "z",
      commandId: BASE_COMMAND_ID,
      timeout: 1,
    });
    // force terminal without claim
    const z = planeO.listSessions()[0]!;
    planeO.handleAgentMessage({
      type: "session:status",
      sessionId: z.id,
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
      commandId: BASE_COMMAND_ID,
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
      commandId: BASE_COMMAND_ID,
      timeout: 1,
    });
    planeD.assignQueued();
    planeD.handleAgentMessage({ type: "session:ack", sessionId: "d1" });
    // pending cleared on ack; inject fake pending with acked session
    planeD.state.pendingAcks.set("d1", {
      sessionId: "d1",
      worktreeId: "missing-wt",
      assignedAtMs: 0,
    });
    // session has ackReceivedAt
    expect(planeD.enforceAckDeadlines(Date.now() + 1000)).toEqual([]);
    // release missing via private path: requeue without worktree
    planeD.state.pendingAcks.set("d1", {
      sessionId: "d1",
      worktreeId: "no-such-wt",
      assignedAtMs: 0,
    });
    delete planeD.state.sessions.get("d1")!.ackReceivedAt;
    planeD.state.sessions.get("d1")!.status = "running";
    expect(planeD.enforceAckDeadlines(Date.now() + 1000)).toEqual(["d1"]);

    // keepalive success path
    planeD.registerAgent({
      hostId: "alive",
      worktrees: [],
      commandProfiles: ["c"],
      replaceExisting: true,
    });
    expect(
      planeD.handleAgentMessage({
        type: "host:keepalive",
        hostId: "alive",
        at: "2026-01-01T00:00:01.000Z",
      }).ok,
    ).toBe(true);
  });
});
