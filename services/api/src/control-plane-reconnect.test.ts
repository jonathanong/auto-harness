/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import {
  reclaimReconnectDeadlines,
  reconcileHostRunningSessions,
} from "./control-plane-reconnect.ts";

function runningPlane() {
  const plane = new ControlPlane({
    now: () => "2026-01-01T00:00:00.000Z",
    reconnectGraceMs: 10,
    idFactory: () => "s",
    connectionIdFactory: (() => {
      let id = 0;
      return () => `c${++id}`;
    })(),
    shardCount: 1,
  });
  seedBaseCommand(plane);
  const registration = plane.registerHost({
    hostId: "h",
    worktrees: [{ id: "w", name: "w", repositoryId: "repo-1", path: "/w", labels: [] }],
    commandProfiles: ["echo-prompt"],
  });
  if (!registration.ok) throw new Error("register");
  plane.createSession(baseSessionBody());
  const [assigned] = plane.assignQueued();
  if (!assigned) throw new Error("assign");
  plane.handleHostMessage({
    type: "session:ack",
    sessionId: "s",
    worktreeId: assigned.worktree.id,
    attemptId: assigned.session.attemptId!,
  });
  plane.disconnectHost(registration.connectionId);
  return plane;
}

function durableRunning(id: string, worktreeId: string, assignmentConnectionId?: string) {
  return {
    id,
    repositoryId: "r",
    prompt: "p",
    targetLabel: "t",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue" as const,
    status: "running" as const,
    queueShard: 0,
    createdAt: "t",
    hostId: "h",
    worktreeId,
    ackReceivedAt: "t",
    reconnectDeadlineAt: "2000-01-01T00:00:00.000Z",
    ...(assignmentConnectionId ? { assignmentConnectionId } : {}),
  };
}

function durableWorktree(id: string, sessionId: string | null, status: "idle" | "busy" = "busy") {
  return {
    id,
    name: id,
    hostId: "h",
    repositoryId: "r",
    path: `/${id}`,
    labels: [],
    status,
    online: false,
    currentSessionId: sessionId,
  };
}

describe("reconnect reconciliation", () => {
  it("retains a reported running session and clears its offline deadline", async () => {
    const plane = runningPlane();
    expect(plane.getSession("s")?.reconnectDeadlineAt).toBeDefined();
    const registered = plane.registerHost({
      hostId: "h",
      worktrees: [{ id: "w", name: "w", repositoryId: "repo-1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
      runningSessions: ["s"],
      replaceExisting: true,
    });
    expect(registered.ok).toBe(true);
    await Promise.resolve();
    expect(plane.getSession("s")?.reconnectDeadlineAt).toBeUndefined();
    expect(plane.getWorktree("w")?.online).toBe(true);
  });

  it("rejects a reported session whose in-memory worktree disappeared", async () => {
    const plane = runningPlane();
    plane.state.worktrees.delete("w");

    await expect(reconcileHostRunningSessions(plane.state, "h", ["s"])).resolves.toBe(false);
  });

  it("requeues omitted work and expires an unreconciled reconnect", async () => {
    const plane = runningPlane();
    const deadline = Date.parse(plane.getSession("s")!.reconnectDeadlineAt!);
    expect(await plane.reclaimReconnectDeadlines(deadline - 1)).toEqual([]);
    expect(await plane.reclaimReconnectDeadlines(deadline)).toEqual(["s"]);
    expect(plane.getSession("s")?.status).toBe("queued");

    const second = runningPlane();
    // A stale local deadline tracker must be removed when the durable/local
    // reconciliation puts the session back into the queue.
    second.state.pendingAcks.set("s", { sessionId: "s", worktreeId: "w", assignedAtMs: 0 });
    second.registerHost({
      hostId: "h",
      worktrees: [{ id: "w", name: "w", repositoryId: "repo-1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
      runningSessions: [],
      replaceExisting: true,
    });
    await Promise.resolve();
    expect(second.getSession("s")?.status).toBe("queued");
    expect(second.getSession("s")?.reconnectDeadlineAt).toBeUndefined();
    expect(second.getSession("s")?.ackReceivedAt).toBeUndefined();
    expect(second.getSession("s")?.startedAt).toBeUndefined();
    expect(second.state.pendingAcks.has("s")).toBe(false);
  });

  it("uses durable fence-aware reconcile and no-lock deadline reclaim paths", async () => {
    const plane = new ControlPlane();
    plane.state.hostConnection.set("h", "c");
    const session = {
      id: "s",
      repositoryId: "r",
      prompt: "p",
      targetLabel: "t",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue" as const,
      status: "running" as const,
      queueShard: 0,
      createdAt: "t",
      hostId: "h",
      worktreeId: "w",
      ackReceivedAt: "t",
      reconnectDeadlineAt: "2000-01-01T00:00:00.000Z",
    };
    const worktree = {
      id: "w",
      name: "w",
      hostId: "h",
      repositoryId: "r",
      path: "/w",
      labels: [],
      status: "busy" as const,
      online: false,
      currentSessionId: "s",
    };
    const calls: string[] = [];
    plane.state.storage = {
      listWorktreesByHost: async () => [worktree],
      listAllSessions: async () => [session],
      getSession: async () => session,
      getWorktree: async () => worktree,
      getHostLock: async () => null,
      confirmReconnect: async () => (calls.push("confirm"), true),
      tryRequeueSession: async (opts: { requireNoHostLock?: string }) => (
        calls.push(opts.requireNoHostLock ? "reclaim" : "omit"), true
      ),
    } as never;
    expect(await reconcileHostRunningSessions(plane.state, "h", ["s"])).toEqual([]);
    expect(calls).toEqual(["confirm"]);
    await reclaimReconnectDeadlines(plane.state, Date.now());
    expect(calls).toContain("reclaim");
  });

  it("requeues a durable omitted session without an assignment fence", async () => {
    const plane = new ControlPlane();
    plane.state.hostConnection.set("h", "c");
    const omitted = durableRunning("omitted-no-fence", "wo");
    const worktree = durableWorktree("wo", omitted.id);
    let requeueOptions: Record<string, unknown> | undefined;
    plane.state.storage = {
      listWorktreesByHost: async () => [worktree],
      getSession: async () => omitted,
      getWorktree: async () => worktree,
      tryRequeueSession: async (options: Record<string, unknown>) => {
        requeueOptions = options;
        return true;
      },
    } as never;

    expect(await reconcileHostRunningSessions(plane.state, "h", [])).toEqual([omitted.id]);
    expect(requeueOptions).toMatchObject({ expectedHostId: "h", nextConnectionId: "c" });
    expect(requeueOptions).not.toHaveProperty("expectedConnectionId");
  });

  it("covers durable reconciliation skips, failed claims, and both deadline fence forms", async () => {
    const plane = new ControlPlane();
    plane.state.hostConnection.set("h", "c");
    const reported = durableRunning("reported", "wr");
    const omitted = durableRunning("omitted", "wo", "old");
    const failed = durableRunning("failed", "wf");
    const rows = [
      durableWorktree("idle", null, "idle"),
      durableWorktree("empty", null),
      durableWorktree("wr", "reported"),
      durableWorktree("wo", "omitted"),
      durableWorktree("wf", "failed"),
    ];
    const calls: Array<Record<string, unknown>> = [];
    plane.state.storage = {
      listWorktreesByHost: async () => rows,
      listAllSessions: async () => [
        reported,
        omitted,
        failed,
        { ...reported, id: "skip", reconnectDeadlineAt: undefined },
      ],
      getSession: async (id: string) => ({ reported, omitted, failed })[id] ?? null,
      getWorktree: async (id: string) => rows.find((row) => row.id === id) ?? null,
      getHostLock: async () => "c",
      confirmReconnect: async () => false,
      tryRequeueSession: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return opts.sessionId !== "failed";
      },
    } as never;
    expect(await reconcileHostRunningSessions(plane.state, "h", ["reported"])).toBe(false);
    expect(await reclaimReconnectDeadlines(plane.state, Date.now())).toEqual([
      "reported",
      "omitted",
    ]);
    expect(calls.some((call) => call.expectedConnectionId === "old" && call.fence)).toBe(true);
    expect(calls.some((call) => call.sessionId === "failed")).toBe(true);
  });

  it("restores earlier durable confirmations when a later reported session loses reconciliation", async () => {
    const plane = new ControlPlane();
    plane.state.hostConnection.set("h", "new");
    const first = durableRunning("first", "w-first", "old");
    const second = durableRunning("second", "w-second", "old");
    const firstWorktree = { ...durableWorktree("w-first", "first"), connectionId: "old" };
    const secondWorktree = { ...durableWorktree("w-second", "second"), connectionId: "old" };
    const calls: string[] = [];
    plane.state.storage = {
      getSession: async (id: string) => ({ first, second })[id] ?? null,
      getWorktree: async (id: string) =>
        ({ "w-first": firstWorktree, "w-second": secondWorktree })[id] ?? null,
      confirmReconnect: async (opts: { sessionId: string }) => {
        calls.push(`confirm:${opts.sessionId}`);
        return opts.sessionId === "first";
      },
      restoreReconnectPending: async (opts: {
        sessionId: string;
        connectionId: string;
        previousDeadlineAt?: string;
        previousAssignmentConnectionId?: string;
        previousWorktreeConnectionId?: string;
      }) => {
        calls.push(`restore:${opts.sessionId}`);
        expect(opts).toMatchObject({
          connectionId: "new",
          previousDeadlineAt: "2000-01-01T00:00:00.000Z",
          previousAssignmentConnectionId: "old",
          previousWorktreeConnectionId: "old",
        });
        return true;
      },
    } as never;

    expect(await reconcileHostRunningSessions(plane.state, "h", ["first", "second"])).toBe(false);
    expect(calls).toEqual(["confirm:first", "confirm:second", "restore:first"]);
    expect(plane.state.sessions.get("first")).toEqual(first);
    expect(plane.state.worktrees.get("w-first")).toEqual(firstWorktree);
  });

  it("does nothing for an unleased durable host", async () => {
    const plane = new ControlPlane();
    plane.state.storage = { listWorktreesByHost: async () => [] } as never;
    await expect(reconcileHostRunningSessions(plane.state, "none", [])).resolves.toEqual([]);
  });

  it("rejects registration and rolls back its lease when grace expiry wins after validation", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "new-connection" });
    const running = durableRunning("sweep-winner", "w");
    const idleInventory = { ...durableWorktree("w", null, "idle"), online: false };
    const busyBeforeSweep = durableWorktree("w", "sweep-winner");
    let sessionReads = 0;
    let worktreeReads = 0;
    const calls: string[] = [];
    plane.state.storage = {
      // Registration validation sees the acknowledged running session. The
      // later reconciliation read sees the grace sweep's queued result.
      getSession: async () => {
        sessionReads++;
        return sessionReads === 1 ? running : { ...running, status: "queued" as const };
      },
      getWorktree: async () => (++worktreeReads === 1 ? busyBeforeSweep : idleInventory),
      listWorktreesByHost: async () => [busyBeforeSweep],
      tryRegisterHost: async () => (calls.push("lease"), true),
      putWorktreeFenced: async () => (calls.push("inventory"), true),
      releaseHostConnection: async () => (calls.push("release"), true),
      getHostLock: async () => null,
      setWorktreeOnlineFenced: async (id: string, connectionId: string, online: boolean) => (
        calls.push(`offline:${id}:${connectionId}:${online}`), true
      ),
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] }],
        commandProfiles: [],
        runningSessions: ["sweep-winner"],
      }),
    ).resolves.toEqual({
      ok: false,
      error: "reported running session lost reconnect reconciliation",
    });
    expect(calls).toEqual(["lease", "inventory", "offline:w:new-connection:false", "release"]);
    expect(plane.state.hostConnection.has("h")).toBe(false);
  });

  it("rolls back mixed scheduled and worktree confirmations after a later report fails", async () => {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      reconnectGraceMs: 10,
    });
    plane.state.hostConnection.set("h", "new");
    const scheduled = {
      ...durableRunning("scheduled", "unused", "old"),
      repositoryId: "scheduled-repo",
      worktreeId: null,
      mainCheckoutLease: true,
    };
    delete scheduled.reconnectDeadlineAt;
    const prompt = durableRunning("prompt", "w", "old");
    const worktree = { ...durableWorktree("w", "prompt"), connectionId: "old" };
    plane.state.sessions.set(scheduled.id, scheduled);
    plane.state.sessions.set(prompt.id, prompt);
    plane.state.worktrees.set(worktree.id, worktree);
    plane.state.mainCheckoutLeases.set("h\0scheduled-repo", {
      sessionId: scheduled.id,
      connectionId: "old",
    });
    const calls: string[] = [];
    plane.state.storage = {
      getSession: async (id: string) =>
        id === scheduled.id ? scheduled : id === prompt.id ? prompt : null,
      getWorktree: async (id: string) => (id === worktree.id ? worktree : null),
      confirmMainCheckoutReconnect: async () => (calls.push("confirm:scheduled"), true),
      confirmReconnect: async () => (calls.push("confirm:prompt"), true),
      restoreReconnectPending: async () => (calls.push("restore:prompt"), true),
      restoreMainCheckoutReconnect: async (opts: { previousDeadlineAt?: string }) => {
        calls.push(`restore:scheduled:${opts.previousDeadlineAt}`);
        return true;
      },
    } as never;

    expect(
      await reconcileHostRunningSessions(plane.state, "h", ["scheduled", "prompt", "missing"]),
    ).toBe(false);
    expect(calls).toEqual([
      "confirm:scheduled",
      "confirm:prompt",
      "restore:prompt",
      "restore:scheduled:2026-01-01T00:00:00.010Z",
    ]);
    expect(plane.state.sessions.get("scheduled")).toMatchObject({
      assignmentConnectionId: "old",
      reconnectDeadlineAt: "2026-01-01T00:00:00.010Z",
    });
    expect(plane.state.sessions.get("prompt")).toEqual(prompt);
    expect(plane.state.worktrees.get("w")).toEqual(worktree);
    expect(plane.state.mainCheckoutLeases.get("h\0scheduled-repo")).toEqual({
      sessionId: "scheduled",
      connectionId: "old",
    });
  });

  it("does not offline replacement B when A loses reconciliation cleanup", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "A" });
    const running = durableRunning("lost", "w");
    const preSweepWorktree = durableWorktree("w", "lost");
    const inventory = {
      ...durableWorktree("w", null, "idle"),
      repositoryId: "repo-1",
      online: false,
    };
    const replacement = { ...inventory, online: true, connectionId: "B" };
    let sessionReads = 0;
    let worktreeReads = 0;
    const calls: string[] = [];
    plane.state.storage = {
      getSession: async () => {
        sessionReads++;
        if (sessionReads === 1) return running;
        // B won after A's registration validation but before reconciliation.
        plane.state.worktrees.set("w", replacement);
        plane.state.hostConnection.set("h", "B");
        plane.state.connections.set("B", {
          connectionId: "B",
          type: "host",
          hostId: "h",
          connectedAt: "now",
          lastHeartbeatAt: "now",
          commandProfiles: ["echo-prompt"],
        });
        return { ...running, status: "queued" as const };
      },
      getWorktree: async () => (++worktreeReads === 1 ? preSweepWorktree : inventory),
      listWorktreesByHost: async () => [preSweepWorktree],
      tryRegisterHost: async () => (calls.push("lease:A"), true),
      putWorktreeFenced: async () => (calls.push("inventory:A"), true),
      setWorktreeOnlineFenced: async (
        _id: string,
        connectionId: string,
        online: boolean,
        fence: { hostId: string; connectionId: string },
      ) => {
        calls.push(`offline:${connectionId}:${online}:${fence.connectionId}`);
        expect(fence).toEqual({ hostId: "h", connectionId: "A" });
        return false;
      },
      releaseHostConnection: async (_hostId: string, connectionId: string) => {
        calls.push(`release:${connectionId}`);
        return false;
      },
      getHostLock: async () => "B",
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] }],
        commandProfiles: [],
        runningSessions: ["lost"],
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(calls).toEqual(["lease:A", "inventory:A", "offline:A:false:A", "release:A"]);
    expect(plane.state.worktrees.get("w")).toEqual(replacement);
    expect(plane.state.hostConnection.get("h")).toBe("B");
    expect(plane.state.disconnectedHosts.has("h")).toBe(false);
    plane.state.storage = undefined;
    seedBaseCommand(plane);
    const queued = plane.createSession(baseSessionBody());
    expect(plane.assignQueued().map((item) => item.session.id)).toEqual([queued.session.id]);
  });

  it("adopts legacy no-deadline reports and ignores expired rows missing ownership", async () => {
    const durable = new ControlPlane();
    durable.state.hostConnection.set("h", "c");
    const legacy = durableRunning("legacy", "w");
    delete legacy.reconnectDeadlineAt;
    const worktree = durableWorktree("w", "legacy");
    let confirmed = 0;
    durable.state.storage = {
      listWorktreesByHost: async () => [worktree],
      getSession: async () => legacy,
      getWorktree: async () => worktree,
      confirmReconnect: async (opts: { deadlineAt?: string }) => {
        expect(opts.deadlineAt).toBeUndefined();
        confirmed++;
        return true;
      },
    } as never;
    expect(await reconcileHostRunningSessions(durable.state, "h", ["legacy"])).toEqual([]);
    expect(confirmed).toBe(1);

    const missing = new ControlPlane();
    missing.state.storage = {
      listAllSessions: async () => [
        durableRunning("orphan", "missing"),
        { ...durableRunning("no-host", "w"), hostId: null },
      ],
      getWorktree: async () => null,
    } as never;
    await expect(reclaimReconnectDeadlines(missing.state, Date.now())).resolves.toEqual([]);

    const local = new ControlPlane();
    local.state.sessions.set("local", durableRunning("local", "lw"));
    local.state.worktrees.set("lw", durableWorktree("lw", "local"));
    expect(await reconcileHostRunningSessions(local.state, "h", ["local"])).toEqual([]);
    expect(local.state.worktrees.get("lw")?.connectionId).toBeUndefined();
  });
});
