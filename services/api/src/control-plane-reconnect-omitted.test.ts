import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

describe("reconcileHostOwnedSessions", () => {
  it("requeues omitted in-memory worktree sessions and skips healthy claims", async () => {
    const state = createControlPlaneState();
    const omitted = {
      id: "omitted",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["cmd"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "wt-1",
      attemptId: "attempt",
    } as SessionRecord;
    const running = { ...omitted, id: "running", worktreeId: "wt-2" };
    state.sessions.set(omitted.id, omitted);
    state.sessions.set(running.id, running);
    state.worktrees.set("wt-1", {
      id: "wt-1",
      name: "wt-1",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt-1",
      labels: [],
      status: "busy",
      currentSessionId: "omitted",
      online: true,
    } as WorktreeRecord);
    state.worktrees.set("wt-2", {
      id: "wt-2",
      name: "wt-2",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt-2",
      labels: [],
      status: "busy",
      currentSessionId: "running",
      online: true,
    } as WorktreeRecord);

    const requeued = await reconcileHostOwnedSessions(
      state,
      "host",
      undefined,
      new Set(["running"]),
      "host-omitted",
    );
    expect(requeued).toEqual(["omitted"]);
    expect(state.sessions.get("omitted")?.status).not.toBe("running");
    expect(state.worktrees.get("wt-1")?.status).toBe("idle");
    expect(state.sessions.get("running")?.status).toBe("running");
  });
});
