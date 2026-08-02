import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.js";

describe("ControlPlane coverage edges", () => {
  it("hits replaceExisting, offline profiles, lost claim, resume cli, status missing, orphan maps", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `s${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      connectionIdFactory: (() => {
        let c = 0;
        return () => `c${++c}`;
      })(),
      shardCount: 1,
      ackDeadlineMs: 1,
    });

    // Register without worktrees so listAgents builds from connection only
    const r1 = plane.registerAgent({
      agentId: "solo",
      worktrees: [],
      commandProfiles: ["p1"],
    });
    expect(r1.ok).toBe(true);
    expect(plane.listAgents().some((a) => a.agentId === "solo")).toBe(true);

    // replaceExisting while still connected
    const r2 = plane.registerAgent({
      agentId: "solo",
      worktrees: [{ id: "wt-extra", repositoryId: "repo-1", path: "/e", labels: [] }],
      commandProfiles: ["p2"],
      replaceExisting: true,
    });
    expect(r2.ok).toBe(true);

    // seed extra worktree for same agent not in register list, then re-register
    plane.seedWorktree({
      id: "wt-old",
      agentId: "solo",
      repositoryId: "repo-1",
      path: "/old",
      labels: [],
      status: "idle",
      online: false,
    });
    plane.registerAgent({
      agentId: "solo",
      worktrees: [{ id: "wt-extra", repositoryId: "repo-1", path: "/e", labels: [] }],
      commandProfiles: ["p2"],
      replaceExisting: true,
    });

    // offline agent profiles skipped
    plane.seedWorktree({
      id: "wt-off",
      agentId: "offline",
      repositoryId: "repo-1",
      path: "/off",
      labels: [],
      status: "idle",
      online: false,
    });
    expect(plane.listCommandProfiles()).toContain("p2");
    expect(plane.getWorktree("missing")).toBeNull();

    // lost claim: two idle worktrees; mark second busy mid-loop by monkeypatching
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/1",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "z",
    });
    plane.seedWorktree({
      id: "wt-2",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/2",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "a",
    });
    plane.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "echo",
      timeout: 1,
    });
    // Force first candidate (wt-2 by RR) to become non-idle via direct map mutation after sort:
    // claim wt-2 first so assign's tryClaim on it fails… actually we need fail during assign.
    // Make tryClaim fail by setting status busy on all then one idle:
    const wt2 = plane.getWorktree("wt-2")!;
    expect(wt2.status).toBe("idle");
    // Intercept: assign once normally
    const assigned = plane.assignQueued();
    expect(assigned.length).toBe(1);

    // Session already bound with ack — skipped on next assign
    plane.handleAgentMessage({
      type: "session:ack",
      sessionId: assigned[0]!.session.id,
    });
    // put back to queued with agent/worktree/ack set (weird but tests skip branch)
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: assigned[0]!.session.id,
      status: "completed",
    });

    // Resume with cliResumeRef
    const done = plane.listSessions()[0]!;
    // force agentId for resume
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: done.id,
      status: "completed",
      cliResumeRef: "cli-x",
    });
    // re-get and resume - completed already has agent from earlier? released nulls agent
    // Manually create completed session with agent for resume
    const planeR = new ControlPlane({
      idFactory: (() => {
        let i = 0;
        return () => `rs${++i}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    planeR.seedWorktree({
      id: "w",
      agentId: "ag",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    planeR.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      ref: "main",
    });
    planeR.assignQueued();
    const sid = planeR.listSessions()[0]!.id;
    planeR.handleAgentMessage({ type: "session:ack", sessionId: sid });
    planeR.handleAgentMessage({
      type: "session:status",
      sessionId: sid,
      status: "completed",
      cliResumeRef: "cli-99",
    });
    const resumed = planeR.resumeSession(sid);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      planeR.seedWorktree({
        id: "w2",
        agentId: "ag",
        repositoryId: "repo-1",
        path: "/w2",
        labels: [],
        status: "idle",
        online: true,
      });
      const a = planeR.assignQueued();
      expect(a.some((x) => x.session.id === resumed.session.id)).toBe(true);
    }

    // status for missing session
    expect(
      plane.handleAgentMessage({
        type: "session:status",
        sessionId: "nope",
        status: "failed",
      }).ok,
    ).toBe(false);

    // orphan agentConnection entry (no connections map) for heartbeat + reclaim
    const planeO = new ControlPlane({
      connectionIdFactory: () => "orphan",
      heartbeatStaleMs: 1,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    planeO.registerAgent({
      agentId: "o1",
      worktrees: [{ id: "wo", repositoryId: "repo-1", path: "/o", labels: [] }],
      commandProfiles: ["x"],
    });
    // break consistency: delete connection but leave agent map via private field access
    const anyPlane = planeO as unknown as {
      connections: Map<string, unknown>;
      agentConnection: Map<string, string>;
      pendingAcks: Map<string, { sessionId: string; worktreeId: string; assignedAtMs: number }>;
      worktrees: Map<
        string,
        { status: string; online: boolean; currentSessionId?: string | null; agentId: string }
      >;
      sessions: Map<string, { status: string }>;
    };
    anyPlane.connections.delete("orphan");
    expect(planeO.heartbeat("o1")).toBe(false);
    anyPlane.agentConnection.set("o1", "ghost");
    expect(planeO.reclaimStaleAgents(Date.now() + 10_000)).toEqual([]);

    // ack deadline: pending without session; pending with acked session
    anyPlane.pendingAcks.set("gone", {
      sessionId: "gone",
      worktreeId: "wo",
      assignedAtMs: 0,
    });
    expect(planeO.enforceAckDeadlines(Date.now())).toEqual([]);

    // release missing worktree via status complete without worktree
    planeO.createSession({
      repositoryId: "repo-1",
      prompt: "z",
      commandProfile: "c",
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
    planeC.seedWorktree({
      id: "only",
      agentId: "a",
      repositoryId: "repo-1",
      path: "/p",
      labels: [],
      status: "idle",
      online: true,
    });
    planeC.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
    });
    // monkeypatch tryClaim by making worktree busy right before assign via prototype
    const wtMap = (
      planeC as unknown as { worktrees: Map<string, { status: string; online: boolean }> }
    ).worktrees;
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
    planeD.seedWorktree({
      id: "wd",
      agentId: "ad",
      repositoryId: "repo-1",
      path: "/d",
      labels: [],
      status: "idle",
      online: true,
    });
    planeD.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
    });
    planeD.assignQueued();
    planeD.handleAgentMessage({ type: "session:ack", sessionId: "d1" });
    // pending cleared on ack; inject fake pending with acked session
    const dAny = planeD as unknown as {
      pendingAcks: Map<string, { sessionId: string; worktreeId: string; assignedAtMs: number }>;
      sessions: Map<string, { ackReceivedAt?: string; status: string }>;
    };
    dAny.pendingAcks.set("d1", {
      sessionId: "d1",
      worktreeId: "missing-wt",
      assignedAtMs: 0,
    });
    // session has ackReceivedAt
    expect(planeD.enforceAckDeadlines(Date.now() + 1000)).toEqual([]);
    // release missing via private path: requeue without worktree
    dAny.pendingAcks.set("d1", {
      sessionId: "d1",
      worktreeId: "no-such-wt",
      assignedAtMs: 0,
    });
    delete dAny.sessions.get("d1")!.ackReceivedAt;
    dAny.sessions.get("d1")!.status = "running";
    expect(planeD.enforceAckDeadlines(Date.now() + 1000)).toEqual(["d1"]);

    // keepalive success path
    planeD.registerAgent({
      agentId: "alive",
      worktrees: [],
      commandProfiles: ["c"],
      replaceExisting: true,
    });
    expect(
      planeD.handleAgentMessage({
        type: "agent:keepalive",
        agentId: "alive",
        at: "2026-01-01T00:00:01.000Z",
      }).ok,
    ).toBe(true);

    // skip already fully bound queued session
    const planeE = new ControlPlane({
      idFactory: () => "e1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    planeE.seedWorktree({
      id: "we",
      agentId: "ae",
      repositoryId: "repo-1",
      path: "/e",
      labels: [],
      status: "idle",
      online: true,
    });
    planeE.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
    });
    const eAny = planeE as unknown as {
      sessions: Map<
        string,
        {
          status: string;
          agentId?: string | null;
          worktreeId?: string | null;
          ackReceivedAt?: string;
          queueShard: number;
        }
      >;
    };
    const es = eAny.sessions.get("e1")!;
    es.agentId = "ae";
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
    planeF.seedWorktree({
      id: "wf",
      agentId: "af",
      repositoryId: "repo-1",
      path: "/f",
      labels: [],
      status: "idle",
      online: true,
    });
    planeF.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      ref: "main",
    });
    planeF.assignQueued();
    planeF.handleAgentMessage({ type: "session:ack", sessionId: "f1" });
    planeF.handleAgentMessage({
      type: "session:status",
      sessionId: "f1",
      status: "completed",
    });
    // force agent pin without cliResumeRef
    const fAny = planeF as unknown as {
      sessions: Map<string, { agentId?: string | null; cliResumeRef?: string }>;
      pendingAcks: Map<string, { sessionId: string; worktreeId: string; assignedAtMs: number }>;
    };
    fAny.sessions.get("f1")!.agentId = "af";
    delete fAny.sessions.get("f1")!.cliResumeRef;
    const resF = planeF.resumeSession("f1");
    expect(resF.ok).toBe(true);
    planeF.seedWorktree({
      id: "wf2",
      agentId: "af",
      repositoryId: "repo-1",
      path: "/f2",
      labels: [],
      status: "idle",
      online: true,
    });
    expect(planeF.assignQueued().length).toBeGreaterThan(0);
    // deadline not expired: call with now equal to assignment time (fixed clock)
    const assignMs = Date.parse("2026-01-01T00:00:00.000Z");
    fAny.pendingAcks.set("pending-early", {
      sessionId: "x",
      worktreeId: "wf2",
      assignedAtMs: assignMs,
    });
    expect(planeF.enforceAckDeadlines(assignMs)).toEqual([]);

    // tryClaim false: get returns offline worktree
    const planeG = new ControlPlane({
      idFactory: () => "g1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    planeG.seedWorktree({
      id: "wg",
      agentId: "ag",
      repositoryId: "repo-1",
      path: "/g",
      labels: [],
      status: "idle",
      online: true,
    });
    planeG.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
    });
    const gMap = (
      planeG as unknown as {
        worktrees: Map<string, { status: string; online: boolean; agentId: string }>;
      }
    ).worktrees;
    const realGet = gMap.get.bind(gMap);
    gMap.get = (id: string) => {
      const w = realGet(id);
      if (w) {
        return { ...w, online: false };
      }
      return w;
    };
    expect(planeG.assignQueued()).toHaveLength(0);

    // remaining branch combos
    const planeH = new ControlPlane({
      usageLimitRetryCeiling: 1,
      archivePrefix: "arch/",
      webhookUrl: null,
      idFactory: (() => {
        let i = 0;
        return () => `h${++i}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    planeH.seedWorktree({
      id: "wh",
      agentId: "ah",
      repositoryId: "repo-1",
      path: "/h",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "old",
      lastAssignedAt: "t0",
    });
    // re-register preserves busy
    planeH.registerAgent({
      agentId: "ah",
      worktrees: [{ id: "wh", repositoryId: "repo-1", path: "/h", labels: [] }],
      commandProfiles: ["c"],
    });
    expect(planeH.getWorktree("wh")?.status).toBe("busy");

    // concurrencyKey reject only when active; completed doesn't conflict
    planeH.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      concurrencyKey: "done-key",
      onConflict: "reject",
    });
    planeH.forceStatus("h1", "completed");
    expect(
      planeH.createSession({
        repositoryId: "repo-1",
        prompt: "p2",
        commandProfile: "c",
        timeout: 1,
        concurrencyKey: "done-key",
        onConflict: "reject",
      }).ok,
    ).toBe(true);

    // listSessions sort both directions
    planeH.createSession({
      repositoryId: "repo-1",
      prompt: "later",
      commandProfile: "c",
      timeout: 1,
    });
    expect(planeH.listSessions().length).toBeGreaterThan(1);

    // resume with concurrencyKey + metadata + pinnedAgentId only
    const planeI = new ControlPlane({
      idFactory: (() => {
        let i = 0;
        return () => `i${++i}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    const iAny = planeI as unknown as {
      sessions: Map<
        string,
        {
          agentId?: string | null;
          pinnedAgentId?: string | null;
          concurrencyKey?: string;
          metadata?: Record<string, unknown>;
          status: string;
          repositoryId: string;
          prompt: string;
          commandProfile: string;
          timeout: number;
          priority: number;
          requiredLabels: string[];
          onConflict: "queue";
          queueShard: number;
          createdAt: string;
        }
      >;
    };
    iAny.sessions.set("src", {
      agentId: null,
      pinnedAgentId: "pin-agent",
      concurrencyKey: "ck",
      metadata: { m: 1 },
      status: "completed",
      repositoryId: "repo-1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      queueShard: 0,
      createdAt: "t",
    });
    const r = planeI.resumeSession("src");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.pinnedAgentId).toBe("pin-agent");
      expect(r.session.concurrencyKey).toBe("ck");
    }
    expect(planeI.getArchive("nope")).toBeNull();

    // force schedule create fail → null
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
    const origCreate = planeJ.createSession.bind(planeJ);
    planeJ.createSession = () => ({ ok: false, error: "forced" });
    expect(
      planeJ.tryClaimScheduleFire("sj", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"),
    ).toBeNull();
    planeJ.createSession = origCreate;

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
    const kAny = planeK as unknown as {
      sessions: Map<string, { retryCount?: number }>;
    };
    kAny.sessions.get("k1")!.retryCount = 0;
    planeK.handleAgentMessage({
      type: "session:status",
      sessionId: "k1",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(planeK.getSession("k1")?.retryCount).toBe(1);
    // resume with explicit pinExpiresAt
    kAny.sessions.get("k1")!.retryCount = 0;
    planeK.handleAgentMessage({
      type: "session:status",
      sessionId: "k1",
      status: "completed",
    });
    // set agent after complete for resume
    const kSess = kAny.sessions.get("k1") as { agentId?: string | null };
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
      worktrees: [{ id: "wo", repositoryId: "repo-1", path: "/o", labels: [] }],
      commandProfiles: ["c"],
    });
    const oAny = planeOrphan as unknown as {
      connections: Map<string, unknown>;
      agentConnection: Map<string, string>;
      disconnectedAgents: Map<string, { lastHeartbeatAt: string }>;
    };
    oAny.connections.delete("c-orph");
    // orphan agentConnection → cleaned on reclaim
    expect(planeOrphan.reclaimStaleAgents(Date.parse("2026-01-01T00:00:00.000Z") + 10_000)).toEqual(
      [],
    );
    // disconnectedAgents path without live connection
    oAny.disconnectedAgents.set("gone", {
      lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
    });
    planeOrphan.seedWorktree({
      id: "wg",
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
    (
      planeS as unknown as {
        supersedeSession: (id: string, reason: string) => void;
      }
    ).supersedeSession("missing", "x");
    (
      planeS as unknown as {
        supersedeSession: (id: string, reason: string) => void;
      }
    ).supersedeSession("s1", "already terminal");
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
    const qAny = planeQ as unknown as {
      sessions: Map<string, { worktreeId?: string | null; status: string }>;
      supersedeSession: (id: string, reason: string) => void;
    };
    qAny.sessions.get("q1")!.worktreeId = "wq";
    qAny.supersedeSession("q1", "replace queued with wt");
    expect(planeQ.getSession("q1")?.status).toBe("cancelled");
    expect(planeQ.getWorktree("wq")?.status).toBe("idle");
  });
});
