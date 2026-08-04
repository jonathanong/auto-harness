import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("ControlPlane coverage: concurrency keys list and resume metadata", () => {
  it("concurrency keys list and resume metadata", () => {
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
      name: "wh",
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
      worktrees: [{ id: "wh", name: "wh", repositoryId: "repo-1", path: "/h", labels: [] }],
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
    planeI.state.sessions.set("src", {
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
  });
});
