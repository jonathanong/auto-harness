import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { supersedeSession } from "./control-plane-sessions.ts";
import { BASE_COMMAND_ID, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane coverage: schedule fail usage limit supersede defaults", () => {
  it("schedule fail usage limit supersede defaults", () => {
    const planeJ = new ControlPlane({
      scheduleIdFactory: () => "sj",
      idFactory: () => "sj-sess",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(planeJ);
    planeJ.putSchedule({
      repositoryId: "repo-1",
      name: "n",
      target: { commandId: BASE_COMMAND_ID },
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

    // Providerless usage limits suppress this target for the queued session.
    const planeK = new ControlPlane({
      archivePrefix: "x/",
      webhookUrl: "https://hook.test",
      idFactory: () => "k1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(planeK);
    planeK.seedWorktree({
      id: "wk",
      name: "wk",
      hostId: "ak",
      repositoryId: "repo-1",
      path: "/k",
      labels: [],
      status: "idle",
      online: true,
    });
    planeK.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const kAssignment = planeK.assignQueued().find((a) => a.session.id === "k1")!;
    planeK.handleHostMessage({
      type: "session:ack",
      sessionId: "k1",
      worktreeId: kAssignment.worktree.id,
      attemptId: kAssignment.session.attemptId!,
    });
    planeK.handleHostMessage({
      type: "session:status",
      sessionId: "k1",
      worktreeId: kAssignment.worktree.id,
      attemptId: kAssignment.session.attemptId!,
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(planeK.getSession("k1")?.suppressedTargetIndexes).toEqual([0]);
    // resume with explicit pinExpiresAt
    planeK.handleHostMessage({
      type: "session:status",
      sessionId: "k1",
      worktreeId: kAssignment.worktree.id,
      attemptId: kAssignment.session.attemptId!,
      status: "completed",
    });
    // set agent after complete for resume
    const kSess = planeK.state.sessions.get("k1") as {
      hostId?: string | null;
      status: "queued" | "running";
      worktreeId?: string | null;
    };
    // The usage-limit branch requeues the source, so create a fresh running
    // assignment before exercising the terminal/resume path.
    kSess.status = "running";
    kSess.worktreeId = kAssignment.worktree.id;
    kSess.hostId = "ak";
    planeK.state.worktrees.set(kAssignment.worktree.id, {
      ...kAssignment.worktree,
      status: "busy",
      currentSessionId: "k1",
    });
    planeK.handleHostMessage({
      type: "session:status",
      sessionId: "k1",
      worktreeId: kAssignment.worktree.id,
      attemptId: kAssignment.session.attemptId!,
      status: "completed",
    });
    expect(planeK.resumeSession("k1", { pinExpiresAt: "2099-01-01T00:00:00.000Z" }).ok).toBe(true);

    // default constructor factories
    const bare = new ControlPlane();
    seedBaseCommand(bare);
    const created = bare.createSession({
      repositoryId: "r",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    expect(created.ok).toBe(true);
    bare.putSchedule({
      repositoryId: "r",
      name: "n",
      target: { commandId: BASE_COMMAND_ID },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2099-01-01T00:00:00.000Z",
    });
    bare.reclaimStaleHosts();
    bare.enforceAckDeadlines();

    // reclaim: orphan agentConnection without connections map entry
    const planeOrphan = new ControlPlane({
      heartbeatStaleMs: 1,
      connectionIdFactory: () => "c-orph",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    planeOrphan.registerHost({
      hostId: "orph",
      worktrees: [{ id: "wo", name: "wo", repositoryId: "repo-1", path: "/o", labels: [] }],
      commandProfiles: ["c"],
    });
    planeOrphan.state.connections.delete("c-orph");
    // orphan agentConnection → cleaned on reclaim
    expect(planeOrphan.reclaimStaleHosts(Date.parse("2026-01-01T00:00:00.000Z") + 10_000)).toEqual(
      [],
    );
    // disconnectedHosts path without live connection
    planeOrphan.state.disconnectedHosts.set("gone", {
      lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
    });
    planeOrphan.seedWorktree({
      id: "wg",
      name: "wg",
      hostId: "gone",
      repositoryId: "repo-1",
      path: "/g",
      labels: [],
      status: "idle",
      online: true,
    });
    planeOrphan.reclaimStaleHosts(Date.parse("2026-01-01T00:00:00.000Z") + 10_000);
    expect(planeOrphan.getWorktree("wg")?.online).toBe(false);

    // supersedeSession defensive path via private call
    const planeS = new ControlPlane({
      idFactory: () => "s1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(planeS);
    planeS.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
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
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(planeQ);
    planeQ.seedWorktree({
      id: "wq",
      name: "wq",
      hostId: "aq",
      repositoryId: "repo-1",
      path: "/q",
      labels: [],
      status: "idle",
      online: true,
    });
    planeQ.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
      concurrencyId: "kq",
    });
    planeQ.state.sessions.get("q1")!.worktreeId = "wq";
    supersedeSession(planeQ.state, "q1", "replace queued with wt");
    expect(planeQ.getSession("q1")?.status).toBe("cancelled");
    expect(planeQ.getWorktree("wq")?.status).toBe("idle");
  });
});
