/* eslint-disable max-lines -- terminal variants share one durable worktree fixture. */
import { describe, expect, it, vi } from "vitest";

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
  it("accepts structured results only from protocol-v3 host connections", async () => {
    const connection = {
      hostId: "host",
      connectionId: "connection",
      type: "host" as const,
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 2,
      providerAccountReadiness: [],
    };
    const result = { summary: "done", summarySource: "agent" as const };

    const legacy = run(row("legacy"));
    legacy.connections.set("connection", connection);
    await expect(
      handleHostMessageDurable(legacy, terminal("legacy", "completed", { result }), "connection"),
    ).resolves.toEqual({ ok: false, error: "session result requires host protocol 3" });
    expect(legacy.sessions.get("legacy")?.status).toBe("running");

    const current = run(row("current"), { getHostLock: async () => "connection" });
    current.connections.set("connection", { ...connection, protocolVersion: 3 });
    await expect(
      handleHostMessageDurable(current, terminal("current", "completed", { result }), "connection"),
    ).resolves.toMatchObject({ ok: true });
    expect(current.sessions.get("current")?.result).toEqual(result);
  });

  it("uses the authenticated transport protocol before the cached connection row", async () => {
    const connection = {
      hostId: "host",
      connectionId: "connection",
      type: "host" as const,
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 2,
      providerAccountReadiness: [],
    };
    const result = { summary: "done", summarySource: "agent" as const };

    const current = run(row("authenticated-current"), { getHostLock: async () => "connection" });
    current.connections.set("connection", { ...connection, protocolVersion: 2 });
    await expect(
      handleHostMessageDurable(
        current,
        terminal("authenticated-current", "completed", { result }),
        "connection",
        false,
        false,
        3,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(current.sessions.get("authenticated-current")?.result).toEqual(result);

    const legacy = run(row("authenticated-legacy"), { getHostLock: async () => "connection" });
    legacy.connections.set("connection", { ...connection, protocolVersion: 3 });
    await expect(
      handleHostMessageDurable(
        legacy,
        terminal("authenticated-legacy", "completed", { result }),
        "connection",
        false,
        false,
        2,
      ),
    ).resolves.toEqual({ ok: false, error: "session result requires host protocol 3" });
    expect(legacy.sessions.get("authenticated-legacy")?.status).toBe("running");
  });

  it("rejects a result when the authenticated connection has no cached protocol row", async () => {
    const uncached = run(row("uncached"));

    await expect(
      handleHostMessageDurable(
        uncached,
        terminal("uncached", "completed", {
          result: { summary: "done", summarySource: "harness" },
        }),
        "missing-connection",
      ),
    ).resolves.toEqual({ ok: false, error: "session result requires host protocol 3" });
    expect(uncached.sessions.get("uncached")?.status).toBe("running");
  });

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
      sessionId: "legacy",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "connection",
    });
  });

  it("reconciles provider-backed legacy occupants after terminal transition", async () => {
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    const state = createControlPlaneState({ now: () => NOW });
    setDurableReadStorage(state, {
      finishSession: async () => true,
      releaseLegacyHostAssignment,
      putArchive: async () => undefined,
    });
    for (const id of ["legacy-a", "legacy-b"]) {
      state.sessions.set(
        id,
        row(id, {
          assignmentConnectionId: "connection",
          worktreeId: null,
          providerAccountLease: {
            concurrencyId: `provider-lease:acct:${id}`,
            providerAccountId: "acct",
            slot: 0,
            attemptId: "attempt",
          },
          resolvedRoute: { providerAccountId: "acct" },
        }),
      );
      await handleHostMessageDurable(state, {
        ...terminal(id, "completed"),
        worktreeId: null,
      });
    }
    expect(releaseLegacyHostAssignment).toHaveBeenCalledTimes(2);
    expect(state.sessions.get("legacy-a")).toMatchObject({ status: "completed" });
    expect(state.sessions.get("legacy-b")).toMatchObject({ status: "completed" });
  });

  it("keeps a committed terminal successful when legacy capacity repair throws", async () => {
    const releaseLegacyHostAssignment = vi.fn(async () => {
      throw new Error("host lock unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const state = createControlPlaneState({ now: () => NOW });
      setDurableReadStorage(state, {
        finishSession: async () => true,
        releaseLegacyHostAssignment,
        putArchive: async () => undefined,
      });
      state.sessions.set(
        "legacy-error",
        row("legacy-error", { assignmentConnectionId: "connection", worktreeId: null }),
      );

      await handleHostMessageDurable(state, {
        ...terminal("legacy-error", "completed"),
        worktreeId: null,
      });

      expect(state.sessions.get("legacy-error")).toMatchObject({ status: "completed" });
      expect(error).toHaveBeenCalledWith(
        "legacy host assignment release failed",
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });
});
