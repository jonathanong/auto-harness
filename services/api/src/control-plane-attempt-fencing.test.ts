/* eslint-disable max-lines -- stale-cache and reconnect claim races stay together. */
import { describe, expect, it } from "vitest";

import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { reconcileHostRunningSessions } from "./control-plane-reconnect.ts";

function assignedPlane() {
  const now = "2026-01-01T00:00:00.000Z";
  let attempt = 0;
  const plane = new ControlPlane({
    now: () => now,
    idFactory: () => "sess-1",
    attemptIdFactory: () => `attempt-${++attempt}`,
    shardCount: 1,
  });
  seedBaseCommand(plane);
  plane.seedWorktree({
    id: "wt-1",
    name: "wt-1",
    hostId: "host-1",
    repositoryId: "repo-1",
    path: "/w",
    labels: [],
    status: "idle",
    online: true,
  });
  expect(plane.createSession(baseSessionBody()).ok).toBe(true);
  return { now, plane };
}

describe("ControlPlane assignment-attempt fencing", () => {
  it("ignores an old ACK and terminal status after the session is re-assigned", () => {
    const { now, plane } = assignedPlane();
    const first = plane.assignQueued()[0]!;
    expect(first.session.attemptId).toBe("attempt-1");
    plane.enforceAckDeadlines(Date.parse(now) + 15_000);
    const second = plane.assignQueued()[0]!;
    expect(second.session.attemptId).toBe("attempt-2");

    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: "wt-1",
      attemptId: first.session.attemptId!,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-1",
      worktreeId: "wt-1",
      attemptId: first.session.attemptId!,
      status: "completed",
    });

    expect(plane.getSession("sess-1")).toMatchObject({
      status: "running",
      worktreeId: "wt-1",
      attemptId: "attempt-2",
    });
    expect(plane.state.pendingAcks.get("sess-1")?.attemptId).toBe("attempt-2");
  });

  it("ignores delayed old-attempt logs after re-assignment", () => {
    const { now, plane } = assignedPlane();
    const first = plane.assignQueued()[0]!;
    plane.enforceAckDeadlines(Date.parse(now) + 15_000);
    expect(plane.assignQueued()).toHaveLength(1);

    expect(
      plane.handleHostMessage({
        type: "session:log",
        sessionId: "sess-1",
        attemptId: first.session.attemptId!,
        stream: "stdout",
        content: "stale",
        timestamp: now,
        seq: 1,
      }),
    ).toEqual({ ok: true });
    expect(plane.getLogs("sess-1")).toEqual([]);

    expect(
      plane.handleHostMessage({
        type: "session:log",
        sessionId: "sess-1",
        attemptId: "attempt-2",
        stream: "stdout",
        content: "current",
        timestamp: now,
        seq: 1,
      }),
    ).toEqual({ ok: true });
    expect(plane.getLogs("sess-1").map((record) => record.content)).toEqual(["current"]);
  });

  it("ignores a delayed old-attempt reconnect claim", async () => {
    const { plane } = assignedPlane();
    const first = plane.assignQueued()[0]!;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: "wt-1",
      attemptId: first.session.attemptId!,
    });

    await expect(
      reconcileHostRunningSessions(
        plane.state,
        "host-1",
        ["sess-1"],
        [{ sessionId: "sess-1", attemptId: "attempt-stale" }],
      ),
    ).resolves.toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
  });

  it("retains a reconnect claim for the current attempt", async () => {
    const { plane } = assignedPlane();
    const first = plane.assignQueued()[0]!;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: "wt-1",
      attemptId: first.session.attemptId!,
    });

    await expect(
      reconcileHostRunningSessions(
        plane.state,
        "host-1",
        ["sess-1"],
        [{ sessionId: "sess-1", attemptId: first.session.attemptId! }],
      ),
    ).resolves.toEqual([]);
    expect(plane.getSession("sess-1")?.status).toBe("running");
  });

  it("ignores delayed old-attempt logs and status on the durable path", async () => {
    const { now, plane } = assignedPlane();
    const first = plane.assignQueued()[0]!;
    plane.enforceAckDeadlines(Date.parse(now) + 15_000);
    const second = plane.assignQueued()[0]!;
    const persisted = { ...plane.getSession("sess-1")! };
    let logs = 0;
    let finished = 0;
    plane.state.storage = {
      getSession: async () => persisted,
      getHostLock: async () => "connection",
      putLogFenced: async () => (logs++, true),
      finishSession: async () => (finished++, true),
    } as never;

    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:log",
          sessionId: "sess-1",
          attemptId: first.session.attemptId!,
          stream: "stdout",
          content: "stale",
          timestamp: now,
          seq: 1,
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:status",
          sessionId: "sess-1",
          worktreeId: "wt-1",
          attemptId: first.session.attemptId!,
          status: "completed",
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    expect(logs).toBe(0);
    expect(finished).toBe(0);
    expect(plane.getSession("sess-1")?.attemptId).toBe(second.session.attemptId);
  });

  it("fences durable logs against storage, not a stale process cache", async () => {
    const { now, plane } = assignedPlane();
    const first = plane.assignQueued()[0]!;
    plane.enforceAckDeadlines(Date.parse(now) + 15_000);
    const second = plane.assignQueued()[0]!;
    plane.state.sessions.set("sess-1", {
      ...plane.getSession("sess-1")!,
      attemptId: first.session.attemptId,
    });
    const persisted = { ...second.session };
    const stored: string[] = [];
    plane.state.storage = {
      getSession: async () => persisted,
      getHostLock: async () => "connection",
      putLogFenced: async (record: { content: string }) => (stored.push(record.content), true),
    } as never;

    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:log",
          sessionId: "sess-1",
          attemptId: first.session.attemptId!,
          stream: "stdout",
          content: "stale-cache",
          timestamp: now,
          seq: 1,
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:log",
          sessionId: "sess-1",
          attemptId: second.session.attemptId!,
          stream: "stdout",
          content: "current-durable",
          timestamp: now,
          seq: 2,
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    expect(stored).toEqual(["current-durable"]);
    expect(plane.getLogs("sess-1").map((record) => record.content)).toEqual(["current-durable"]);
    expect(plane.getSession("sess-1")?.attemptId).toBe(second.session.attemptId);
  });

  it("withholds new assignments from daemons below the fenced protocol", () => {
    const plane = new ControlPlane({ shardCount: 1, idFactory: () => "sess-legacy" });
    seedBaseCommand(plane);
    expect(
      plane.handleHostMessage({
        type: "host:register",
        hostId: "legacy",
        worktrees: [
          { id: "wt-legacy", name: "legacy", repositoryId: "repo-1", path: "/legacy", labels: [] },
        ],
        runtime: { daemonVersion: "0.0.0", gitVersion: "2.36.0", gitReady: true },
      }).ok,
    ).toBe(true);
    expect(plane.createSession(baseSessionBody()).ok).toBe(true);
    expect(plane.assignQueued()).toEqual([]);

    expect(
      plane.handleHostMessage({
        type: "host:register",
        hostId: "modern",
        worktrees: [
          { id: "wt-modern", name: "modern", repositoryId: "repo-1", path: "/modern", labels: [] },
        ],
        protocolVersion: HOST_PROTOCOL_VERSION,
        runtime: { daemonVersion: "1.0.0", gitVersion: "2.36.0", gitReady: true },
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    expect(plane.getSession("sess-legacy")?.hostId).toBe("modern");
  });
});
