import { describe, expect, it, vi } from "vitest";

import { assignQueued } from "./control-plane-assign.ts";
import { handleHostMessage } from "./control-plane-messages.ts";
import { assignScheduledQueuedDurable } from "./control-plane-scheduled-assign.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { expireTerminalHookHandoffIfNeeded } from "./control-plane-terminal-hook-handoff.ts";
import { tryClaimWorktree } from "./control-plane-worktrees.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    infrastructureRetryCount: 1,
    ...overrides,
  };
}

function queued(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const next = running({
    id,
    status: "queued",
    hostId: null,
    worktreeId: null,
    infrastructureRetryCount: 0,
    ...overrides,
  });
  delete next.attemptId;
  return next;
}

function v7State() {
  const state = createControlPlaneState({
    now: () => NOW,
    idFactory: () => "handoff",
    attemptIdFactory: () => "next-attempt",
    shardCount: 1,
  });
  state.hostConnection.set("host", "connection");
  state.connections.set("connection", {
    type: "host",
    hostId: "host",
    connectionId: "connection",
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    repositoryIds: ["repo"],
    capabilities: ["scheduled-main-checkout"],
    protocolVersion: 7,
    negotiatedProtocolVersion: 7,
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
  });
  state.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  return state;
}

function busyWorktree(): WorktreeRecord {
  return {
    id: "worktree",
    name: "worktree",
    hostId: "host",
    repositoryId: "repo",
    path: "/worktree",
    labels: [],
    status: "busy",
    online: true,
    currentSessionId: "session",
  };
}

function exhaustedFailure(worktreeId: string | null = "worktree") {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId,
    attemptId: "attempt",
    status: "failed" as const,
    errorCode: "checkout_fetch_failed" as const,
    deferTerminalHookResult: true as const,
  };
}

function completeHandoff() {
  return {
    type: "session:terminal-hook-complete" as const,
    sessionId: "session",
    handoffId: "handoff",
  };
}

describe("in-memory exhausted checkout reservation", () => {
  it("blocks a second prompt from claiming the failed worktree until settlement", async () => {
    const state = v7State();
    state.sessions.set("session", running());
    state.worktrees.set("worktree", busyWorktree());
    expect(handleHostMessage(state, exhaustedFailure(), "connection")).toEqual({ ok: true });
    expect(state.worktrees.get("worktree")).toMatchObject({
      status: "busy",
      currentSessionId: "session",
    });
    expect(tryClaimWorktree(state, "worktree", "other", NOW)).toBe(false);
    state.sessions.set("other", queued("other"));
    expect(assignQueued(state)).toEqual([]);

    expect(handleHostMessage(state, completeHandoff(), "connection")).toEqual({ ok: true });
    await vi.waitFor(() => expect(state.worktrees.get("worktree")?.status).toBe("idle"));
    expect(assignQueued(state)).toHaveLength(1);
    expect(state.sessions.get("other")).toMatchObject({
      status: "running",
      worktreeId: "worktree",
    });
  });

  it("blocks a second scheduled session from claiming the failed main checkout", async () => {
    const state = v7State();
    state.hostInventories.set("host", {
      hostId: "host",
      repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: NOW,
    });
    state.sessions.set(
      "session",
      running({
        type: "scheduled",
        source: "schedule",
        principalId: "system",
        worktreeId: null,
        mainCheckoutLease: true,
        assignmentConnectionId: "connection",
      }),
    );
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: "session",
      connectionId: "connection",
    });
    expect(handleHostMessage(state, exhaustedFailure(null), "connection")).toEqual({ ok: true });
    expect(state.sessions.get("session")).toMatchObject({
      mainCheckoutLease: true,
      terminalHookHandoff: { mainCheckoutLease: true },
    });
    expect(state.mainCheckoutLeases.get("host\0repo")?.sessionId).toBe("session");
    state.sessions.set(
      "other",
      queued("other", { type: "scheduled", source: "schedule", principalId: "system" }),
    );
    await expect(assignScheduledQueuedDurable(state)).resolves.toEqual([]);

    expect(handleHostMessage(state, completeHandoff(), "connection")).toEqual({ ok: true });
    await vi.waitFor(() => expect(state.mainCheckoutLeases.size).toBe(0));
    await expect(assignScheduledQueuedDurable(state)).resolves.toHaveLength(1);
    expect(state.sessions.get("other")?.mainCheckoutLease).toBe(true);
  });

  it("releases a reserved worktree when the exhausted handoff expires", async () => {
    const state = v7State();
    state.sessions.set("session", running());
    state.worktrees.set("worktree", busyWorktree());
    expect(handleHostMessage(state, exhaustedFailure(), "connection")).toEqual({ ok: true });
    const session = state.sessions.get("session")!;
    await expect(
      expireTerminalHookHandoffIfNeeded(state, session, Date.parse("2026-01-02T00:00:00.001Z")),
    ).resolves.toBe(true);
    expect(state.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(tryClaimWorktree(state, "worktree", "other", NOW)).toBe(true);
  });

  it("does not finish a deferred main-checkout when the lease is already gone", () => {
    const state = v7State();
    state.sessions.set(
      "session",
      running({
        worktreeId: null,
        mainCheckoutLease: true,
        assignmentConnectionId: "connection",
      }),
    );
    expect(handleHostMessage(state, exhaustedFailure(null), "connection")).toEqual({ ok: true });
    expect(state.sessions.get("session")).toMatchObject({ status: "running" });
    expect(state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();
  });
});
