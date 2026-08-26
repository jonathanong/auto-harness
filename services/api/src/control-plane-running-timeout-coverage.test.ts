/* eslint-disable max-lines -- timeout coverage cases share one session fixture. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { settleStorage } from "./control-plane-state.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import {
  RUNNING_TIMEOUT_NOW as NOW,
  RUNNING_TIMEOUT_SECONDS as TIMEOUT_SECONDS,
  runningDeadlineMs,
  startAcknowledgedRunning,
} from "./control-plane-running-timeout-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

function scheduledRunning(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sched",
    repositoryId: "repo-1",
    prompt: "nightly",
    target: { commandId: "cmd-base" },
    fallbacks: [],
    targetDisplayNames: ["cmd-base"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-08-21T17:19:39.015Z",
    timeout: TIMEOUT_SECONDS,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    startedAt: NOW,
    ackReceivedAt: NOW,
    attemptId: "attempt",
    hostId: "host",
    worktreeId: null,
    assignmentConnectionId: "conn",
    mainCheckoutLease: true,
    ...over,
  };
}

describe("running timeout residual coverage", () => {
  it("skips queued, unacked, undated, and invalid running rows", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    seedBaseCommand(plane);
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo-1", path: "/wt", labels: [] }],
    });
    const queued = plane.createSession(baseSessionBody({ timeout: 1 }));
    expect(queued.ok).toBe(true);
    if (!queued.ok) throw new Error(queued.error);
    plane.assignQueued();
    const assigned = plane.state.sessions.get(queued.session.id)!;
    const far = Date.parse(NOW) + 60_000;
    expect(plane.enforceRunningTimeouts(far)).toEqual([]);
    expect(await plane.enforceRunningTimeoutsDurable(far)).toEqual([]);
    assigned.status = "running";
    assigned.ackReceivedAt = "not-a-date";
    expect(plane.enforceRunningTimeouts(far)).toEqual([]);
    delete assigned.ackReceivedAt;
    expect(plane.enforceRunningTimeouts(far)).toEqual([]);
    assigned.ackReceivedAt = new Date(Date.now() - 2_000).toISOString();
    assigned.timeout = 1;
    expect(plane.enforceRunningTimeouts()).toEqual([assigned.id]);
  });

  it("sends session:cancel and leaves a mismatched worktree busy", () => {
    const cancels: string[] = [];
    const plane = new ControlPlane({
      now: () => NOW,
      onHostMessage: (hostId, message) => {
        if (message.type === "session:cancel") cancels.push(`${hostId}:${message.sessionId}`);
      },
    });
    const { sessionId, worktreeId } = startAcknowledgedRunning(plane);
    plane.state.worktrees.get(worktreeId)!.currentSessionId = "other";
    expect(plane.enforceRunningTimeouts(runningDeadlineMs(plane, sessionId))).toEqual([sessionId]);
    expect(plane.getWorktree(worktreeId)?.status).toBe("busy");
    expect(plane.getSession(sessionId)?.worktreeId).toBeNull();
    expect(cancels).toEqual([`host:${sessionId}`]);
  });

  it("releases a scheduled main-checkout lease and a concurrency lock", async () => {
    const released: string[] = [];
    const plane = new ControlPlane({ now: () => NOW });
    const session = scheduledRunning({ concurrencyId: "lock" });
    plane.state.sessions.set(session.id, session);
    plane.state.mainCheckoutLeases.set("host\0repo-1", {
      sessionId: session.id,
      connectionId: "conn",
    });
    plane.state.storage = {
      putSession: async () => undefined,
      listLogs: async () => [],
      putArchive: async () => undefined,
      releaseConcurrencyLock: async (id: string) => {
        released.push(id);
      },
    } as never;
    expect(plane.enforceRunningTimeouts(Date.parse(NOW) + TIMEOUT_SECONDS * 1000)).toEqual([
      session.id,
    ]);
    expect(plane.state.mainCheckoutLeases.size).toBe(0);
    expect(plane.getSession(session.id)).toMatchObject({ status: "timed_out", hostId: null });
    await settleStorage(plane.state);
    expect(released).toEqual(["lock"]);
  });

  it("hydrates running rows then times them out when storage has no finish path", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    const row = scheduledRunning({ id: "hydrated", mainCheckoutLease: undefined, hostId: null });
    plane.state.storage = {
      listAllSessions: async () => [row],
      listLogs: async () => [],
      putArchive: async () => undefined,
    } as never;
    expect(
      await plane.enforceRunningTimeoutsDurable(Date.parse(NOW) + TIMEOUT_SECONDS * 1000),
    ).toEqual(["hydrated"]);
    expect(plane.getSession("hydrated")?.status).toBe("timed_out");
  });

  it("finishes stranded work through durable storage and ignores a lost race", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    const { sessionId, worktreeId } = startAcknowledgedRunning(plane);
    plane.state.worktrees.get(worktreeId)!.currentSessionId = "other";
    const session = { ...plane.state.sessions.get(sessionId)!, concurrencyId: "lock" };
    let finished: unknown;
    plane.state.storage = {
      listAllSessions: async () => [session],
      listLogs: async () => [],
      putArchive: async () => undefined,
      finishSession: async (opts: unknown) => {
        finished = opts;
        return true;
      },
    } as never;
    expect(await plane.enforceRunningTimeoutsDurable(runningDeadlineMs(plane, sessionId))).toEqual([
      sessionId,
    ]);
    expect(finished).toMatchObject({
      sessionId,
      worktreeId,
      status: "timed_out",
      concurrencyId: "lock",
    });
    expect(plane.getSession(sessionId)?.status).toBe("timed_out");
    expect(plane.getWorktree(worktreeId)?.status).toBe("busy");

    const other = new ControlPlane({ now: () => NOW });
    const again = startAcknowledgedRunning(other);
    other.state.storage = {
      finishSession: async () => false,
      releaseMainCheckoutSession: async () => false,
    } as never;
    expect(
      await other.enforceRunningTimeoutsDurable(runningDeadlineMs(other, again.sessionId)),
    ).toEqual([]);
    expect(other.getSession(again.sessionId)?.status).toBe("running");
  });

  it("releases a scheduled lease through durable storage and locally times out the rest", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    const session = scheduledRunning();
    plane.state.sessions.set(session.id, session);
    plane.state.mainCheckoutLeases.set("host\0repo-1", {
      sessionId: session.id,
      connectionId: "conn",
    });
    const released: unknown[] = [];
    plane.state.storage = {
      listLogs: async () => [],
      putArchive: async () => undefined,
      releaseMainCheckoutSession: async (opts: unknown) => {
        released.push(opts);
        return true;
      },
    } as never;
    expect(
      await plane.enforceRunningTimeoutsDurable(Date.parse(NOW) + TIMEOUT_SECONDS * 1000),
    ).toEqual([session.id]);
    expect(released[0]).toMatchObject({ sessionId: session.id, status: "timed_out" });
    expect(plane.state.mainCheckoutLeases.size).toBe(0);

    const local = new ControlPlane({ now: () => NOW });
    const onlyStorage = scheduledRunning({ id: "only-storage" });
    const stale = scheduledRunning({ id: "stale" });
    local.state.sessions.set("stale", { ...stale, status: "completed" });
    local.state.storage = {
      listSessionsByStatus: async (status: string, shard: number) =>
        shard === 0 && status === "running" ? [onlyStorage, stale] : [],
      listLogs: async () => [],
      putArchive: async () => undefined,
      finishSession: async () => true,
    } as never;
    expect(
      await local.enforceRunningTimeoutsDurable(Date.parse(NOW) + TIMEOUT_SECONDS * 1000),
    ).toEqual(["only-storage"]);
    expect(local.getSession("only-storage")?.status).toBe("timed_out");
    expect(local.getSession("stale")?.status).toBe("completed");
  });

  it("releases matching durable worktrees, notifies hosts, and handles optional timeout fences", async () => {
    const cancels: string[] = [];
    const plane = new ControlPlane({
      now: () => NOW,
      onHostMessage: (hostId, message) => cancels.push(`${hostId}:${message.type}`),
    });
    const leased = scheduledRunning({
      id: "leased",
      worktreeId: "worktree",
      attemptId: undefined,
      concurrencyId: "lock",
    });
    const ordinary = scheduledRunning({
      id: "ordinary",
      mainCheckoutLease: undefined,
      assignmentConnectionId: undefined,
      worktreeId: null,
    });
    const fenced = scheduledRunning({
      id: "fenced",
      mainCheckoutLease: undefined,
      worktreeId: null,
    });
    const future = scheduledRunning({
      id: "future",
      ackReceivedAt: new Date(Date.parse(NOW) + TIMEOUT_SECONDS * 1000).toISOString(),
    });
    plane.state.sessions.set(leased.id, leased);
    plane.state.sessions.set(ordinary.id, ordinary);
    plane.state.worktrees.set("worktree", {
      id: "worktree",
      name: "worktree",
      repositoryId: "repo-1",
      hostId: "host",
      path: "/worktree",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: leased.id,
    });
    plane.state.storage = {
      listAllSessions: async () => [leased, ordinary, fenced, future],
      releaseMainCheckoutSession: async () => true,
      finishSession: async () => true,
      listLogs: async () => [],
      putArchive: async () => undefined,
    } as never;
    await expect(
      plane.enforceRunningTimeoutsDurable(Date.parse(NOW) + TIMEOUT_SECONDS * 1000),
    ).resolves.toEqual(["leased", "ordinary", "fenced"]);
    expect(plane.state.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(cancels).toEqual(["host:session:cancel", "host:session:cancel", "host:session:cancel"]);
  });
});
