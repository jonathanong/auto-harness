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
  plane.assignQueued();
  plane.handleHostMessage({ type: "session:ack", sessionId: "s" });
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

  it("requeues omitted work and expires an unreconciled reconnect", async () => {
    const plane = runningPlane();
    const deadline = Date.parse(plane.getSession("s")!.reconnectDeadlineAt!);
    expect(await plane.reclaimReconnectDeadlines(deadline - 1)).toEqual([]);
    expect(await plane.reclaimReconnectDeadlines(deadline)).toEqual(["s"]);
    expect(plane.getSession("s")?.status).toBe("queued");

    const second = runningPlane();
    second.registerHost({
      hostId: "h",
      worktrees: [{ id: "w", name: "w", repositoryId: "repo-1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
      runningSessions: [],
      replaceExisting: true,
    });
    await Promise.resolve();
    expect(second.getSession("s")?.status).toBe("queued");
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
    await reconcileHostRunningSessions(plane.state, "h", ["s"]);
    expect(calls).toEqual(["confirm"]);
    await reclaimReconnectDeadlines(plane.state, Date.now());
    expect(calls).toContain("reclaim");
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
    expect(await reconcileHostRunningSessions(plane.state, "h", ["reported"])).toEqual(["omitted"]);
    expect(await reclaimReconnectDeadlines(plane.state, Date.now())).toEqual([
      "reported",
      "omitted",
    ]);
    expect(calls.some((call) => call.expectedConnectionId === "old" && call.fence)).toBe(true);
    expect(calls.some((call) => call.sessionId === "failed")).toBe(true);
  });

  it("does nothing for an unleased durable host", async () => {
    const plane = new ControlPlane();
    plane.state.storage = { listWorktreesByHost: async () => [] } as never;
    await expect(reconcileHostRunningSessions(plane.state, "none", [])).resolves.toEqual([]);
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
      confirmReconnect: async (opts: { deadlineAt?: string }) => {
        expect(opts.deadlineAt).toBeUndefined();
        confirmed++;
        return true;
      },
    } as never;
    await reconcileHostRunningSessions(durable.state, "h", ["legacy"]);
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
    await reconcileHostRunningSessions(local.state, "h", ["local"]);
    expect(local.state.worktrees.get("lw")?.connectionId).toBeUndefined();
  });
});
