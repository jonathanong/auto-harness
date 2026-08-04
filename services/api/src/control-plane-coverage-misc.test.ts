import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { supersedeSession } from "./control-plane-sessions.ts";

describe("ControlPlane coverage: schedule fail usage limit supersede defaults", () => {
  it("schedule fail usage limit supersede defaults", () => {
    const planeJ = new ControlPlane({
      scheduleIdFactory: () => "sj",
      idFactory: () => "sj-sess",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    planeJ.putSchedule({
      repositoryId: "repo-1",
      name: "n",
      commandProfile: "c",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
    });
    // Force createSession failure after claim by clearing required fields on schedule
    planeJ.state.schedules.get("sj")!.repositoryId = "";
    expect(
      planeJ.tryClaimScheduleFire("sj", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"),
    ).toBeNull();

    // constructor overrides + retryCount defined path on usage_limit
    const planeK = new ControlPlane({
      usageLimitRetryCeiling: 3,
      archivePrefix: "x/",
      webhookUrl: "https://hook.test",
      idFactory: () => "k1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    planeK.seedWorktree({
      id: "wk",
      name: "wk",
      agentId: "ak",
      repositoryId: "repo-1",
      path: "/k",
      labels: [],
      status: "idle",
      online: true,
    });
    planeK.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
    });
    planeK.assignQueued();
    planeK.handleAgentMessage({ type: "session:ack", sessionId: "k1" });
    planeK.state.sessions.get("k1")!.retryCount = 0;
    planeK.handleAgentMessage({
      type: "session:status",
      sessionId: "k1",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(planeK.getSession("k1")?.retryCount).toBe(1);
    // resume with explicit pinExpiresAt
    planeK.state.sessions.get("k1")!.retryCount = 0;
    planeK.handleAgentMessage({
      type: "session:status",
      sessionId: "k1",
      status: "completed",
    });
    // set agent after complete for resume
    const kSess = planeK.state.sessions.get("k1") as { agentId?: string | null };
    kSess.agentId = "ak";
    expect(planeK.resumeSession("k1", { pinExpiresAt: "2099-01-01T00:00:00.000Z" }).ok).toBe(true);

    // default constructor factories
    const bare = new ControlPlane();
    const created = bare.createSession({
      repositoryId: "r",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
    });
    expect(created.ok).toBe(true);
    bare.putSchedule({
      repositoryId: "r",
      name: "n",
      commandProfile: "c",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2099-01-01T00:00:00.000Z",
    });
    bare.reclaimStaleAgents();
    bare.enforceAckDeadlines();

    // reclaim: orphan agentConnection without connections map entry
    const planeOrphan = new ControlPlane({
      heartbeatStaleMs: 1,
      connectionIdFactory: () => "c-orph",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    planeOrphan.registerAgent({
      agentId: "orph",
      worktrees: [{ id: "wo", name: "wo", repositoryId: "repo-1", path: "/o", labels: [] }],
      commandProfiles: ["c"],
    });
    planeOrphan.state.connections.delete("c-orph");
    // orphan agentConnection → cleaned on reclaim
    expect(planeOrphan.reclaimStaleAgents(Date.parse("2026-01-01T00:00:00.000Z") + 10_000)).toEqual(
      [],
    );
    // disconnectedAgents path without live connection
    planeOrphan.state.disconnectedAgents.set("gone", {
      lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
    });
    planeOrphan.seedWorktree({
      id: "wg",
      name: "wg",
      agentId: "gone",
      repositoryId: "repo-1",
      path: "/g",
      labels: [],
      status: "idle",
      online: true,
    });
    planeOrphan.reclaimStaleAgents(Date.parse("2026-01-01T00:00:00.000Z") + 10_000);
    expect(planeOrphan.getWorktree("wg")?.online).toBe(false);

    // supersedeSession defensive path via private call
    const planeS = new ControlPlane({ idFactory: () => "s1", now: () => "t" });
    planeS.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
    });
    planeS.forceStatus("s1", "completed");
    supersedeSession(planeS.state, "missing", "x");
    supersedeSession(planeS.state, "s1", "already terminal");
    expect(planeS.getSession("s1")?.status).toBe("completed");

    // supersede queued session that still has a worktree id (edge)
    const planeQ = new ControlPlane({
      idFactory: (() => {
        let qi = 0;
        return () => `q${++qi}`;
      })(),
      now: () => "t",
      shardCount: 1,
    });
    planeQ.seedWorktree({
      id: "wq",
      name: "wq",
      agentId: "aq",
      repositoryId: "repo-1",
      path: "/q",
      labels: [],
      status: "idle",
      online: true,
    });
    planeQ.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      concurrencyKey: "kq",
      onConflict: "queue",
    });
    planeQ.state.sessions.get("q1")!.worktreeId = "wq";
    supersedeSession(planeQ.state, "q1", "replace queued with wt");
    expect(planeQ.getSession("q1")?.status).toBe("cancelled");
    expect(planeQ.getWorktree("wq")?.status).toBe("idle");
  });
});
