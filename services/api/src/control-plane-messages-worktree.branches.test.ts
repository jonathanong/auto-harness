import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function row(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    hostId: "host",
    worktreeId: "w",
    attemptId: "attempt",
    ...over,
  };
}

function run(session: SessionRecord) {
  const state = createControlPlaneState({ now: () => NOW, usageLimitRetryCeiling: 1 });
  setDurableReadStorage(state, {
    finishSession: async () => true,
    suppressProviderlessUsageLimit: async () => true,
    releaseCancelledSessionWorktree: async () => true,
    putArchive: async () => undefined,
  });
  state.sessions.set(session.id, session);
  return state;
}

const terminal = (sessionId: string, status: "completed" | "failed" | "timed_out", extra = {}) => ({
  type: "session:status" as const,
  sessionId,
  worktreeId: "w",
  attemptId: "attempt",
  status,
  ...extra,
});

describe("durable worktree terminal branches", () => {
  it("finishes completion, usage-limit retry, and cancelled late release", async () => {
    const worktree: WorktreeRecord = {
      id: "w",
      name: "w",
      hostId: "host",
      repositoryId: "repo",
      path: "/w",
      labels: [],
      status: "busy",
      online: false,
      currentSessionId: "done",
    };
    const completed = run(row("done"));
    completed.worktrees.set("w", worktree);
    await handleHostMessageDurable(
      completed,
      terminal("done", "completed", { cliResumeRef: "ref" }),
    );
    expect(completed.worktrees.get("w")).toMatchObject({ status: "idle", currentSessionId: null });
    expect(completed.sessions.get("done")).toMatchObject({
      status: "completed",
      worktreeId: null,
      cliResumeRef: "ref",
    });

    const retry = run(row("retry"));
    retry.worktrees.set("w", { ...worktree, currentSessionId: "retry" });
    await handleHostMessageDurable(
      retry,
      terminal("retry", "failed", { errorCode: "usage_limit" }),
    );
    expect(retry.sessions.get("retry")).toMatchObject({
      status: "queued",
      hostId: null,
      suppressedTargetIndexes: [0],
    });

    const cancelled = run(row("cancelled", { status: "cancelled" }));
    cancelled.worktrees.set("w", { ...worktree, currentSessionId: "cancelled" });
    await handleHostMessageDurable(
      cancelled,
      terminal("cancelled", "timed_out", { cliResumeRef: "late" }),
    );
    expect(cancelled.worktrees.get("w")).toMatchObject({ status: "idle", currentSessionId: null });
  });

  it("does not fail a legacy providerless terminal when host capacity is already zero", async () => {
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    const state = createControlPlaneState({ now: () => NOW });
    setDurableReadStorage(state, {
      finishSession: async () => true,
      releaseLegacyHostAssignment,
      putArchive: async () => undefined,
    });
    state.sessions.set(
      "legacy",
      row("legacy", { assignmentConnectionId: "connection", worktreeId: null }),
    );

    await handleHostMessageDurable(state, {
      ...terminal("legacy", "completed"),
      worktreeId: null,
    });

    expect(state.sessions.get("legacy")).toMatchObject({ status: "completed" });
    expect(releaseLegacyHostAssignment).toHaveBeenCalledWith({
      hostId: "host",
      connectionId: "connection",
    });
  });
});
