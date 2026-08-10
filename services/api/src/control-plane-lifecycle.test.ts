/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane lifecycle", () => {
  it("reclaims stale agents and offlines all worktrees", () => {
    const plane = new ControlPlane({
      heartbeatStaleMs: 1_000,
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-1",
      connectionIdFactory: () => "conn-1",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.registerHost({
      hostId: "a1",
      worktrees: [
        { id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/w", labels: [] },
        { id: "wt-idle", name: "wt-idle", repositoryId: "repo-1", path: "/i", labels: [] },
      ],
      commandProfiles: ["echo-prompt"],
    });
    plane.heartbeat("a1", "2026-01-01T00:00:00.000Z");
    plane.createSession(baseSessionBody({ timeout: 3600 }));
    const assigned = plane.assignQueued()[0]!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
    });

    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const reclaimed = plane.reclaimStaleHosts(t0 + 2_000);
    expect(reclaimed).toEqual([]);
    expect(plane.getSession("sess-1")?.status).toBe("running");
    expect(plane.getSession("sess-1")?.reconnectDeadlineAt).toBeDefined();
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
    expect(plane.getWorktree("wt-1")?.online).toBe(false);
    // idle worktree of dead agent also offline — no zombie assign
    expect(plane.getWorktree("wt-idle")?.online).toBe(false);
    expect(plane.assignQueued()).toHaveLength(0);
    expect(plane.getHeartbeatStaleMs()).toBeLessThan(3600 * 1000);
  });

  it("disconnect frees busy worktrees and prevents zombie assigns", () => {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-1",
      connectionIdFactory: () => "conn-1",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    const reg = plane.registerHost({
      hostId: "a1",
      worktrees: [
        { id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/w", labels: [] },
        { id: "wt-2", name: "wt-2", repositoryId: "repo-1", path: "/w2", labels: [] },
      ],
      commandProfiles: ["echo-prompt"],
    });
    expect(reg.ok).toBe(true);
    plane.createSession(baseSessionBody());
    const assigned = plane.assignQueued()[0]!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
    });
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");

    if (!reg.ok) {
      return;
    }
    expect(plane.disconnectHost("missing-conn")).toEqual([]);
    const freed = plane.disconnectHost(reg.connectionId);
    expect(freed).toEqual([]);
    expect(plane.getSession("sess-1")?.status).toBe("running");
    expect(plane.getSession("sess-1")?.reconnectDeadlineAt).toBeDefined();
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
    expect(plane.getWorktree("wt-1")?.online).toBe(false);
    expect(plane.getWorktree("wt-2")?.online).toBe(false);
    // cannot assign to disconnected zombie
    expect(plane.assignQueued()).toHaveLength(0);
  });

  it("requeues acknowledged work only after its reconnect deadline", async () => {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      reconnectGraceMs: 75_000,
      idFactory: () => "sess-1",
      connectionIdFactory: () => "conn-1",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    const registration = plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
    });
    if (!registration.ok) {
      throw new Error(`registerHost failed: ${registration.error}`);
    }
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    const assigned = plane.getSession("sess-1")!;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
    });
    plane.disconnectHost(registration.connectionId);
    const deadline = Date.parse(plane.getSession("sess-1")!.reconnectDeadlineAt!);
    expect(await plane.reclaimReconnectDeadlines(deadline - 1)).toEqual([]);
    expect(plane.getSession("sess-1")?.status).toBe("running");
    expect(await plane.reclaimReconnectDeadlines(deadline)).toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
  });

  it("archives logs and delivers optional webhook on terminal", () => {
    const plane = new ControlPlane({
      idFactory: () => "sess-1",
      now: () => "2026-01-01T00:00:00.000Z",
      webhookUrl: "https://example.test/hook",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    const assigned = plane.assignQueued()[0]!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
    });
    plane.handleHostMessage({
      type: "session:log",
      sessionId: "sess-1",
      stream: "stdout",
      content: "hi",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
      status: "completed",
    });
    expect(plane.getArchive("sess-1")?.body).toContain("hi");
    expect(plane.listWebhookDeliveries()).toHaveLength(1);
    plane.setWebhookUrl(null);
    expect(plane.listArchives()).toHaveLength(1);
  });

  it("drain agent is sticky: released busy worktree stays offline", () => {
    const msgs: HostWireMessage[] = [];
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onHostMessage: (_a, m) => {
        msgs.push(m);
      },
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
      repositoryId: "repo-1",
      path: "/w1",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.seedWorktree({
      id: "wt-2",
      name: "wt-2",
      hostId: "a1",
      repositoryId: "repo-1",
      path: "/w2",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    const assigned = plane.assignQueued()[0]!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
    });
    const drain = plane.drainHost("a1");
    expect(drain.runningSessionIds).toEqual(["sess-1"]);
    expect(plane.isDraining("a1")).toBe(true);
    expect(msgs.some((m) => m.type === "host:drain")).toBe(true);
    expect(plane.getWorktree("wt-2")?.online).toBe(false);

    // finish in-flight session — release must keep worktree offline
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
      status: "completed",
    });
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
    expect(plane.getWorktree("wt-1")?.online).toBe(false);

    plane.createSession(baseSessionBody({ prompt: "after drain" }));
    expect(plane.assignQueued()).toHaveLength(0);
  });
});
