import { describe, expect, it } from "vitest";

import type { AgentWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody } from "./control-plane-test-helpers.ts";

describe("ControlPlane lifecycle", () => {
  it("reclaims stale agents and offlines all worktrees", () => {
    const plane = new ControlPlane({
      heartbeatStaleMs: 1_000,
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-1",
      connectionIdFactory: () => "conn-1",
      shardCount: 1,
    });
    plane.registerAgent({
      agentId: "a1",
      worktrees: [
        { id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/w", labels: [] },
        { id: "wt-idle", name: "wt-idle", repositoryId: "repo-1", path: "/i", labels: [] },
      ],
      commandProfiles: ["echo-prompt"],
    });
    plane.heartbeat("a1", "2026-01-01T00:00:00.000Z");
    plane.createSession(baseSessionBody({ timeout: 3600 }));
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-1" });

    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const reclaimed = plane.reclaimStaleAgents(t0 + 2_000);
    expect(reclaimed).toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
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
    const reg = plane.registerAgent({
      agentId: "a1",
      worktrees: [
        { id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/w", labels: [] },
        { id: "wt-2", name: "wt-2", repositoryId: "repo-1", path: "/w2", labels: [] },
      ],
      commandProfiles: ["echo-prompt"],
    });
    expect(reg.ok).toBe(true);
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-1" });
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");

    if (!reg.ok) {
      return;
    }
    expect(plane.disconnectAgent("missing-conn")).toEqual([]);
    const freed = plane.disconnectAgent(reg.connectionId);
    expect(freed).toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
    expect(plane.getWorktree("wt-1")?.online).toBe(false);
    expect(plane.getWorktree("wt-2")?.online).toBe(false);
    // cannot assign to disconnected zombie
    expect(plane.assignQueued()).toHaveLength(0);
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
      name: "wt-1",
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

  it("drain agent is sticky: released busy worktree stays offline", () => {
    const msgs: AgentWireMessage[] = [];
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onAgentMessage: (_a, m) => {
        msgs.push(m);
      },
    });
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w1",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.seedWorktree({
      id: "wt-2",
      name: "wt-2",
      agentId: "a1",
      repositoryId: "repo-1",
      path: "/w2",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    plane.handleAgentMessage({ type: "session:ack", sessionId: "sess-1" });
    const drain = plane.drainAgent("a1");
    expect(drain.runningSessionIds).toEqual(["sess-1"]);
    expect(plane.isDraining("a1")).toBe(true);
    expect(msgs.some((m) => m.type === "agent:drain")).toBe(true);
    expect(plane.getWorktree("wt-2")?.online).toBe(false);

    // finish in-flight session — release must keep worktree offline
    plane.handleAgentMessage({
      type: "session:status",
      sessionId: "sess-1",
      status: "completed",
    });
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
    expect(plane.getWorktree("wt-1")?.online).toBe(false);

    plane.createSession(baseSessionBody({ prompt: "after drain" }));
    expect(plane.assignQueued()).toHaveLength(0);
  });
});
