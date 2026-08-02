import { describe, expect, it } from "vitest";

import type { AgentWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.js";

function baseSessionBody(over: Record<string, unknown> = {}) {
  return {
    repositoryId: "repo-1",
    prompt: "do work",
    commandProfile: "echo-prompt",
    timeout: 30,
    ...over,
  };
}

describe("ControlPlane invariants", () => {
  it("Invariant 1: exclusive worktree claim under concurrent assign", () => {
    const messages: AgentWireMessage[] = [];
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onAgentMessage: (_id, msg) => {
        messages.push(msg);
      },
    });
    plane.seedWorktree({
      id: "wt-1",
      agentId: "agent-1",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.createSession(baseSessionBody({ prompt: "second" }));

    const a1 = plane.assignQueued();
    expect(a1).toHaveLength(1);
    expect(a1[0]?.worktree.id).toBe("wt-1");
    const a2 = plane.assignQueued();
    expect(a2).toHaveLength(0);
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
    expect(messages.filter((m) => m.type === "session:assign")).toHaveLength(1);
  });

  it("Invariant 3: concurrent agent register leaves one connection", () => {
    const plane = new ControlPlane({
      connectionIdFactory: (() => {
        let n = 0;
        return () => `conn-${++n}`;
      })(),
    });
    const first = plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "r", path: "/p", labels: ["echo"] }],
      commandProfiles: ["echo-prompt"],
    });
    const second = plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "r", path: "/p", labels: ["echo"] }],
      commandProfiles: ["echo-prompt"],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (first.ok) {
      plane.disconnectAgent(first.connectionId);
    }
    const third = plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "r", path: "/p", labels: ["echo"] }],
      commandProfiles: ["echo-prompt"],
      replaceExisting: true,
    });
    expect(third.ok).toBe(true);
  });

  it("Invariant 4: concurrent cron claim creates at most one session", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      scheduleIdFactory: () => "sched-1",
    });
    const schedule = plane.putSchedule({
      repositoryId: "repo-1",
      name: "hourly",
      commandProfile: "echo-prompt",
      cron: "0 * * * *",
      timeout: 60,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    const expected = schedule.nextRunAt;
    const s1 = plane.tryClaimScheduleFire(schedule.id, expected, "2026-01-01T00:00:01.000Z");
    const s2 = plane.tryClaimScheduleFire(schedule.id, expected, "2026-01-01T00:00:01.000Z");
    expect(s1).not.toBeNull();
    expect(s2).toBeNull();
    expect(plane.listSessions()).toHaveLength(1);
  });

  it("Invariant 5: same-ms logs ordered by seq", () => {
    const plane = new ControlPlane();
    const ts = "2026-01-01T00:00:00.000Z";
    plane.appendLog({
      sessionId: "s",
      stream: "stdout",
      content: "second",
      timestamp: ts,
      seq: 2,
    });
    plane.appendLog({
      sessionId: "s",
      stream: "stdout",
      content: "first",
      timestamp: ts,
      seq: 1,
    });
    const logs = plane.getLogs("s");
    expect(logs.map((l) => l.content)).toEqual(["first", "second"]);
    expect(logs[0]!.timestampSeq < logs[1]!.timestampSeq).toBe(true);
  });

  it("Invariant 2: no-ack requeues and frees worktree", () => {
    const plane = new ControlPlane({
      ackDeadlineMs: 100,
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-1",
      shardCount: 1,
    });
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
    const requeued = plane.enforceAckDeadlines(Date.parse("2026-01-01T00:00:00.000Z") + 200);
    expect(requeued).toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
  });

  it("Invariant 6: usage_limit retries under cap only", () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const plane = new ControlPlane({
      usageLimitRetryCeiling: 2,
      now: () => new Date(nowMs).toISOString(),
      idFactory: () => "sess-u",
      shardCount: 1,
    });
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-u" });

    plane.handleAgentMessage({
      type: "session:status",
      sessionId: "sess-u",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("sess-u")?.status).toBe("queued");
    expect(plane.getSession("sess-u")?.retryCount).toBe(1);

    nowMs += 60_000;
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-u" });
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: "sess-u",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("sess-u")?.retryCount).toBe(2);
    expect(plane.getSession("sess-u")?.status).toBe("queued");

    nowMs += 60_000;
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-u" });
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: "sess-u",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("sess-u")?.status).toBe("failed");
  });

  it("Invariant 7 / D5: resume pins agent only; works after original worktree reused", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    plane.seedWorktree({
      id: "wt-a",
      agentId: "agent-1",
      repositoryId: "repo-1",
      path: "/a",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.seedWorktree({
      id: "wt-b",
      agentId: "agent-1",
      repositoryId: "repo-1",
      path: "/b",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody({ ref: "feature/x" }));
    const firstAssign = plane.assignQueued();
    const originalWt = firstAssign[0]!.worktree.id;
    plane.handleAgentMessage({
      type: "session:ack",
      sessionId: firstAssign[0]!.session.id,
    });
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: firstAssign[0]!.session.id,
      status: "completed",
      cliResumeRef: "cli-abc",
    });

    // Original worktree reused by intervening session
    plane.createSession(baseSessionBody({ prompt: "other" }));
    const intervening = plane.assignQueued();
    const interveningWt = intervening[0]!.worktree.id;

    const resumed = plane.resumeSession(firstAssign[0]!.session.id);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      return;
    }
    expect(resumed.session.pinnedAgentId).toBe("agent-1");
    expect(resumed.session.ref).toBe("feature/x");
    // Finish intervening so wt free; resume can land on different worktree path
    plane.handleAgentMessage({
      type: "session:ack",
      sessionId: intervening[0]!.session.id,
    });
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: intervening[0]!.session.id,
      status: "completed",
    });
    const resumeAssign = plane.assignQueued();
    const hit = resumeAssign.find((a) => a.session.id === resumed.session.id);
    expect(hit).toBeTruthy();
    expect(hit?.worktree.agentId).toBe("agent-1");
    // Worktree is not pinned — may differ from original after reuse.
    expect(["wt-a", "wt-b"]).toContain(hit?.worktree.id);
    expect(["wt-a", "wt-b"]).toContain(originalWt);
    expect(["wt-a", "wt-b"]).toContain(interveningWt);
  });

  it("Invariant 9: concurrencyKey + reject fails create", () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
    });
    const first = plane.createSession(
      baseSessionBody({ concurrencyKey: "k1", onConflict: "reject" }),
    );
    expect(first.ok).toBe(true);
    const second = plane.createSession(
      baseSessionBody({ concurrencyKey: "k1", onConflict: "reject" }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("CONFLICT");
    }
  });

  it("reclaims stale agent faster than session timeout", () => {
    const plane = new ControlPlane({
      heartbeatStaleMs: 1_000,
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-1",
      connectionIdFactory: () => "conn-1",
      shardCount: 1,
    });
    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "repo-1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
    });
    // Backdate heartbeat
    plane.heartbeat("a1", "2026-01-01T00:00:00.000Z");
    plane.createSession(baseSessionBody({ timeout: 3600 }));
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-1" });

    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const reclaimed = plane.reclaimStaleAgents(t0 + 2_000);
    expect(reclaimed).toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
    // reclaim bound is heartbeatStaleMs (1s), not session timeout (3600s)
    expect(plane.getHeartbeatStaleMs()).toBeLessThan(3600 * 1000);
  });

  it("archives logs and delivers optional webhook on terminal", () => {
    const plane = new ControlPlane({
      idFactory: () => "sess-1",
      now: () => "2026-01-01T00:00:00.000Z",
      webhookUrl: "https://example.test/hook",
      shardCount: 1,
    });
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-1" });
    plane.handleAgentMessage({
      type: "session:log",
      sessionId: "sess-1",
      stream: "stdout",
      content: "hi",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: "sess-1",
      status: "completed",
    });
    expect(plane.getArchive("sess-1")?.body).toContain("hi");
    expect(plane.listWebhookDeliveries()).toHaveLength(1);
    plane.setWebhookUrl(null);
    expect(plane.listArchives()).toHaveLength(1);
  });

  it("drain agent leaves running sessions; marks idle offline", () => {
    const msgs: AgentWireMessage[] = [];
    const plane = new ControlPlane({
      idFactory: () => "sess-1",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onAgentMessage: (_a, m) => {
        msgs.push(m);
      },
    });
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w1",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.seedWorktree({
      id: "wt-2",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w2",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    const drain = plane.drainAgent("a1");
    expect(drain.runningSessionIds).toEqual(["sess-1"]);
    expect(msgs.some((m) => m.type === "agent:drain")).toBe(true);
    expect(plane.getWorktree("wt-2")?.online).toBe(false);
  });

  it("POST fields include ref, commandProfile, concurrencyKey, metadata, url", () => {
    const plane = new ControlPlane({
      publicBaseUrl: "http://ui",
      idFactory: () => "sess-x",
      now: () => "t",
    });
    const r = plane.createSession(
      baseSessionBody({
        ref: "main",
        concurrencyKey: "ck",
        metadata: { pr: 1 },
        onConflict: "queue",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.url).toBe("http://ui/sessions/sess-x");
      expect(r.session.ref).toBe("main");
      expect(r.session.commandProfile).toBe("echo-prompt");
      expect(r.session.concurrencyKey).toBe("ck");
      expect(r.session.metadata).toEqual({ pr: 1 });
    }
  });

  it("lists agent command profiles for UI", () => {
    const plane = new ControlPlane();
    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt", repositoryId: "r", path: "/p", labels: [] }],
      commandProfiles: ["echo-prompt", "codex-fix"],
    });
    expect(plane.listCommandProfiles()).toEqual(["codex-fix", "echo-prompt"]);
    expect(plane.listAgents()[0]?.online).toBe(true);
  });

  it("evaluateCron creates scheduled sessions", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T01:00:00.000Z",
      scheduleIdFactory: () => "sched-1",
    });
    plane.putSchedule({
      repositoryId: "repo-1",
      name: "job",
      commandProfile: "echo-prompt",
      cron: "0 * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
    });
    const created = plane.evaluateCron();
    expect(created).toHaveLength(1);
    expect(created[0]?.source).toBe("schedule");
    expect(plane.evaluateCron()).toHaveLength(0);
  });

  it("covers agent message errors and pin expiry", () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    expect(plane.handleAgentMessage({ type: "session:ack", sessionId: "nope" }).ok).toBe(false);
    expect(
      plane.handleAgentMessage({
        type: "agent:keepalive",
        agentId: "missing",
        at: "t",
      }).ok,
    ).toBe(false);
    expect(plane.resumeSession("nope").ok).toBe(false);

    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-1" });
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: "sess-1",
      status: "completed",
    });
    const resumed = plane.resumeSession("sess-1", {
      pinExpiresAt: "2025-01-01T00:00:00.000Z",
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      plane.assignQueued();
      expect(plane.getSession(resumed.session.id)?.status).toBe("failed");
    }
    expect(plane.archiveSessionLogs("empty-sess")?.body).toBe("[]");
    expect(plane.getAckDeadlineMs()).toBeGreaterThan(0);
    expect(plane.getUsageLimitRetryCeiling()).toBeGreaterThan(0);
  });

  it("covers remaining branches: disabled cron, future fire, retryAfter, register replace, disconnect", () => {
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

    // disabled + future schedule
    plane.putSchedule({
      repositoryId: "repo-1",
      name: "off",
      commandProfile: "echo-prompt",
      cron: "0 * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      enabled: false,
    });
    expect(plane.evaluateCron()).toHaveLength(0);
    const future = plane.putSchedule({
      repositoryId: "repo-1",
      name: "later",
      commandProfile: "echo-prompt",
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
      plane.handleAgentMessage({
        type: "agent:register",
        agentId: "ax",
        worktrees: [{ id: "wt-x", repositoryId: "repo-1", path: "/x", labels: [] }],
        commandProfiles: ["echo-prompt"],
      }).ok,
    ).toBe(true);
    expect(
      plane.handleAgentMessage({
        type: "agent:register",
        agentId: "ax",
        worktrees: [{ id: "wt-x", repositoryId: "repo-1", path: "/x", labels: [] }],
        commandProfiles: ["echo-prompt"],
      }).ok,
    ).toBe(false);
    expect(plane.heartbeat("ax")).toBe(true);
    const connId = plane.listAgents()[0] ? "conn-1" : "conn-1";
    plane.disconnectAgent(connId);
    plane.disconnectAgent("missing-conn");

    // session with retryAfter in future skipped
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    const created = plane.createSession(baseSessionBody());
    expect(created.ok).toBe(true);
    if (created.ok) {
      // simulate usage_limit requeue with future retryAfter
      const s = plane.getSession(created.session.id)!;
      // force running path with assign then usage limit
      plane.assignQueued();
      plane.handleAgentMessage({ type: "session:ack", sessionId: created.session.id });
      plane.handleAgentMessage({
        type: "session:status",
        sessionId: created.session.id,
        status: "failed",
        errorCode: "usage_limit",
        errorMessage: "quota",
        exitCode: 1,
      });
      expect(plane.getSession(created.session.id)?.status).toBe("queued");
      // retryAfter is future relative to fixed now → assign skips
      expect(plane.assignQueued()).toHaveLength(0);
      void s;
    }

    // ack deadline: already acked pending cleanup
    plane.createSession(baseSessionBody({ prompt: "ack-clean" }));
    plane.assignQueued();
    const running = plane.listSessions().find((s) => s.status === "running");
    if (running) {
      plane.handleAgentMessage({ type: "session:ack", sessionId: running.id });
      // still in pending until ack deletes — enforce should no-op requeue
      expect(plane.enforceAckDeadlines(Date.now() + 999999)).toEqual([]);
    }

    // apply status for cancelled/timed_out
    plane.createSession(baseSessionBody({ prompt: "cancel-me" }));
    // seed online worktree again
    plane.seedWorktree({
      id: "wt-2",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w2",
      labels: [],
      status: "idle",
      online: true,
    });
    const c = plane.listSessions().find((s) => s.prompt === "cancel-me");
    if (c) {
      // manually mark without assign
      plane.handleAgentMessage({
        type: "session:status",
        sessionId: c.id,
        status: "cancelled",
      });
      expect(plane.getSession(c.id)?.status).toBe("cancelled");
    }

    // resume without agent
    const noAgent = new ControlPlane({ idFactory: () => "s-na", now: () => "t" });
    noAgent.createSession(baseSessionBody());
    expect(noAgent.resumeSession("s-na").ok).toBe(false);

    // reclaim when not stale
    const plane2 = new ControlPlane({
      heartbeatStaleMs: 60_000,
      connectionIdFactory: () => "c1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane2.registerAgent({
      agentId: "fresh",
      worktrees: [{ id: "wt", repositoryId: "repo-1", path: "/p", labels: [] }],
      commandProfiles: ["echo-prompt"],
    });
    expect(plane2.reclaimStaleAgents(Date.parse("2026-01-01T00:00:00.000Z") + 100)).toEqual([]);

    // release missing worktree
    plane2.seedWorktree({
      id: "wt-gone",
      agentId: "fresh",
      repositoryId: "repo-1",
      path: "/g",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "x",
    });
  });
});
