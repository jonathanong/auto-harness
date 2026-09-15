/* eslint-disable max-lines -- terminal variants share one durable worktree fixture. */
import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
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
    targetDisplayNames: ["cmd"],
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

function run(session: SessionRecord, methods: Record<string, unknown> = {}) {
  const state = createControlPlaneState({ now: () => NOW });
  setDurableReadStorage(state, {
    finishSession: async () => true,
    suppressProviderlessUsageLimit: async () => true,
    releaseCancelledSessionWorktree: async () => true,
    putArchive: async () => undefined,
    ...methods,
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
    const finishes: Record<string, unknown>[] = [];
    const completed = run(row("done"), {
      finishSession: async (input: Record<string, unknown>) => (finishes.push(input), true),
    });
    completed.worktrees.set("w", worktree);
    const completedResult = { summary: "changed files", summarySource: "agent" as const };
    await handleHostMessageDurable(
      completed,
      terminal("done", "completed", { cliResumeRef: "ref", result: completedResult }),
    );
    expect(finishes[0]).toMatchObject({ result: completedResult });
    expect(completed.worktrees.get("w")).toMatchObject({ status: "idle", currentSessionId: null });
    expect(completed.sessions.get("done")).toMatchObject({
      status: "completed",
      worktreeId: null,
      cliResumeRef: "ref",
      result: completedResult,
    });
    await handleHostMessageDurable(
      completed,
      terminal("done", "completed", {
        result: { summary: "stale overwrite", summarySource: "harness" },
      }),
    );
    expect(finishes).toHaveLength(1);
    expect(completed.sessions.get("done")?.result).toEqual(completedResult);

    const retry = run(
      row("retry", { result: { summary: "intermediate", summarySource: "agent" } }),
    );
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
    expect(retry.sessions.get("retry")).not.toHaveProperty("result");

    const cancelled = run(row("cancelled", { status: "cancelled" }));
    cancelled.worktrees.set("w", { ...worktree, currentSessionId: "cancelled" });
    await handleHostMessageDurable(
      cancelled,
      terminal("cancelled", "timed_out", {
        cliResumeRef: "late",
        result: { summary: "cancelled result", summarySource: "harness" },
      }),
    );
    expect(cancelled.worktrees.get("w")).toMatchObject({ status: "idle", currentSessionId: null });
    expect(cancelled.sessions.get("cancelled")?.result).toEqual({
      summary: "cancelled result",
      summarySource: "harness",
    });
  });
});
