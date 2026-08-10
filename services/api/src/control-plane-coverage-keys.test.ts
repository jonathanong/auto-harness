import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { BASE_COMMAND_ID, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane coverage: concurrency keys list and resume metadata", () => {
  it("concurrency keys list and resume metadata", () => {
    const planeH = new ControlPlane({
      archivePrefix: "arch/",
      webhookUrl: null,
      idFactory: (() => {
        let i = 0;
        return () => `h${++i}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(planeH);
    planeH.seedWorktree({
      id: "wh",
      name: "wh",
      hostId: "ah",
      repositoryId: "repo-1",
      path: "/h",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "old",
      lastAssignedAt: "t0",
    });
    // re-register preserves busy
    planeH.registerHost({
      hostId: "ah",
      worktrees: [{ id: "wh", name: "wh", repositoryId: "repo-1", path: "/h", labels: [] }],
      commandProfiles: ["c"],
    });
    expect(planeH.getWorktree("wh")?.status).toBe("busy");

    // concurrencyKey reject only when active; completed doesn't conflict
    planeH.createSession({
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
      concurrencyKey: "done-key",
      onConflict: "reject",
    });
    planeH.forceStatus("h1", "completed");
    expect(
      planeH.createSession({
        repositoryId: "repo-1",
        prompt: "p2",
        target: { commandId: BASE_COMMAND_ID },
        timeout: 1,
        concurrencyKey: "done-key",
        onConflict: "reject",
      }).ok,
    ).toBe(true);

    // listSessions sort both directions
    planeH.createSession({
      repositoryId: "repo-1",
      prompt: "later",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    expect(planeH.listSessions().length).toBeGreaterThan(1);

    // resume with concurrencyKey + metadata + pinnedHostId only
    const planeI = new ControlPlane({
      idFactory: (() => {
        let i = 0;
        return () => `i${++i}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    planeI.state.sessions.set("src", {
      id: "src",
      hostId: null,
      pinnedHostId: "older-pin-agent",
      resolvedRoute: {
        targetIndex: 0,
        commandId: BASE_COMMAND_ID,
        hostId: "pin-agent",
        worktreeId: "old-worktree",
      },
      concurrencyKey: "ck",
      metadata: { m: 1 },
      status: "completed",
      repositoryId: "repo-1",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      fallbacks: [],
      targetLabels: ["c"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
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
      expect(r.session.pinnedHostId).toBe("pin-agent");
      expect(r.session.concurrencyKey).toBe("ck");
    }
    expect(planeI.getArchive("nope")).toBeNull();
  });
});
