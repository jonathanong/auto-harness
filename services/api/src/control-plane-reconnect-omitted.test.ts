import { describe, expect, it, vi } from "vitest";

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

  it("requeues local workspace ownership and ignores foreign or reported slots", async () => {
    const state = createControlPlaneState();
    const workspace = {
      id: "workspace",
      repositoryId: "",
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      workspaceSlotLease: true,
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
      worktreeId: null,
      attemptId: "attempt",
    } as SessionRecord;
    const foreign = { ...workspace, id: "foreign", workspaceSlotId: "foreign-slot" };
    const reported = { ...workspace, id: "reported", workspaceSlotId: "reported-slot" };
    state.sessions.set(workspace.id, workspace);
    state.sessions.set(foreign.id, foreign);
    state.sessions.set(reported.id, reported);
    state.workspaceSlots.set("slot", {
      id: "slot",
      name: "slot",
      path: "/workspace/slot",
      hostId: "host",
      workspacePoolId: "pool",
      status: "busy",
      online: true,
      currentSessionId: workspace.id,
      errorMessage: "stale error",
    });
    state.workspaceSlots.set("foreign-slot", {
      id: "foreign-slot",
      name: "foreign",
      path: "/workspace/foreign",
      hostId: "other-host",
      workspacePoolId: "pool",
      status: "busy",
      online: true,
      currentSessionId: foreign.id,
    });
    state.workspaceSlots.set("reported-slot", {
      id: "reported-slot",
      name: "reported",
      path: "/workspace/reported",
      hostId: "host",
      workspacePoolId: "pool",
      status: "busy",
      online: true,
      currentSessionId: reported.id,
    });

    await expect(
      reconcileHostOwnedSessions(state, "host", undefined, new Set([reported.id]), "omitted"),
    ).resolves.toEqual([workspace.id]);
    expect(state.sessions.get(workspace.id)).toMatchObject({
      status: "queued",
      workspaceSlotId: null,
    });
    expect(state.workspaceSlots.get("slot")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(state.workspaceSlots.get("slot")).not.toHaveProperty("errorMessage");
    expect(state.sessions.get(foreign.id)?.status).toBe("running");
    expect(state.sessions.get(reported.id)?.status).toBe("running");
  });

  it("does not release a durable workspace row without the current connection", async () => {
    const state = createControlPlaneState();
    const workspace = {
      id: "workspace",
      repositoryId: "",
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      workspaceSlotLease: true,
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
      worktreeId: null,
      attemptId: "attempt",
    } as SessionRecord;
    const slot = {
      id: "slot",
      name: "slot",
      path: "/workspace/slot",
      hostId: "host",
      workspacePoolId: "pool",
      status: "busy" as const,
      online: true,
      currentSessionId: workspace.id,
    };
    state.sessions.set(workspace.id, workspace);
    const finishSession = vi.fn(async () => true);
    state.storage = { getWorkspaceSlot: async () => slot, finishSession } as never;

    await expect(
      reconcileHostOwnedSessions(state, "host", undefined, new Set(), "omitted"),
    ).resolves.toEqual([]);
    expect(finishSession).not.toHaveBeenCalled();
    expect(state.sessions.get(workspace.id)?.status).toBe("running");
  });
});
