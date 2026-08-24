/* eslint-disable max-lines -- assignment coverage cases share one fixture. */
import { describe, expect, it } from "vitest";

import {
  assignQueued,
  assignQueuedDurable,
  enforceAckDeadlinesDurable,
} from "./control-plane-assign.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "missing" },
    fallbacks: [],
    targetLabels: ["missing"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    ...over,
  };
}

const worktree: WorktreeRecord = {
  id: "w",
  name: "w",
  hostId: "host",
  repositoryId: "repo",
  path: "/repo/w",
  labels: [],
  status: "idle",
  online: true,
  connectionId: "connection",
};

describe("assignment residual coverage", () => {
  it("skips locally and durably queued work while repository admission is unavailable", async () => {
    const local = createControlPlaneState({ now: () => NOW, shardCount: 1 });
    local.sessions.set("s", session());
    expect(assignQueued(local)).toEqual([]);

    const durable = createControlPlaneState({ now: () => NOW, shardCount: 1 });
    durable.sessions.set("s", session());
    setDurableReadStorage(durable, { expireQueuedSession: async () => false });
    await expect(assignQueuedDurable(durable)).resolves.toEqual([]);
  });

  it("skips an otherwise eligible durable worktree without a live host connection", async () => {
    const state = createControlPlaneState({ now: () => NOW, shardCount: 1 });
    state.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "/repo",
      defaultBranch: "main",
      admissionState: "active",
      admissionStateChangedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["tool"],
      appendPrompt: true,
      providerId: null,
    });
    state.sessions.set("s", session({ target: { commandId: "command" } }));
    state.worktrees.set("w", worktree);
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      repositoryIds: ["repo"],
      capabilities: [],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 1,
    });
    state.hostConnection.set("host", "connection");
    const liveGet = state.hostConnection.get.bind(state.hostConnection);
    let planningReads = 2;
    let assigned = 0;
    state.hostConnection.get = (hostId) => {
      if (planningReads === 0) return undefined;
      planningReads -= 1;
      return liveGet(hostId);
    };
    setDurableReadStorage(state, {
      expireQueuedSession: async () => false,
      tryAssignSession: async () => {
        assigned += 1;
        return true;
      },
    });
    await expect(assignQueuedDurable(state)).resolves.toEqual([]);
    expect(assigned).toBe(0);
  });

  it("fails closed for a connected host whose Git preflight is not ready", () => {
    const state = createControlPlaneState({ now: () => NOW, shardCount: 1 });
    state.sessions.set("s", session({ target: { commandId: "command" } }));
    state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["tool"],
      appendPrompt: true,
      providerId: null,
    });
    state.worktrees.set("w", worktree);
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: {
        daemonVersion: "test",
        gitVersion: "2.35.0",
        gitReady: false,
        gitReadinessReason: "git_version_unsupported",
      },
    });
    state.hostConnection.set("host", "connection");

    expect(assignQueued(state)).toEqual([]);
  });

  it("durably assigns a pinned frozen native continuation", async () => {
    const state = createControlPlaneState({
      now: () => NOW,
      attemptIdFactory: () => "attempt",
      shardCount: 1,
    });
    state.sessions.set(
      "s",
      session({
        resumedFromSessionId: "old",
        resumeFallback: true,
        pinnedHostId: "host",
        pinnedTargetIndex: 0,
        pinnedCommandId: "frozen",
        resumeSpec: { argv: ["frozen"], appendPrompt: true },
      }),
    );
    state.worktrees.set("w", worktree);
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 1,
    });
    state.hostConnection.set("host", "connection");
    setDurableReadStorage(state, {
      tryAssignSession: async () => true,
      expireQueuedSession: async () => false,
      clearResumePin: async () => true,
    });

    await expect(assignQueuedDurable(state)).resolves.toHaveLength(1);
    expect(state.sessions.get("s")).toMatchObject({
      status: "running",
      worktreeId: "w",
      resolvedArgv: ["frozen", "run"],
    });
  });

  it("supports a minimal legacy storage implementation without session scans", async () => {
    const state = createControlPlaneState();
    state.storage = {} as never;
    await expect(enforceAckDeadlinesDurable(state, Date.parse(NOW))).resolves.toEqual([]);
  });

  it("drops a stale scheduled deadline that lacks an assignment fence", async () => {
    const state = createControlPlaneState({ ackDeadlineMs: 1 });
    const row = session({
      id: "scheduled",
      type: "scheduled",
      source: "schedule",
      status: "running",
      attemptId: "attempt",
      worktreeId: null,
    });
    state.sessions.set(row.id, row);
    state.pendingAcks.set(row.id, {
      sessionId: row.id,
      worktreeId: null,
      attemptId: "attempt",
      assignedAtMs: 0,
    });
    setDurableReadStorage(state, { releaseMainCheckoutSession: async () => true });

    await expect(enforceAckDeadlinesDurable(state, 2)).resolves.toEqual([]);
    expect(state.pendingAcks.has(row.id)).toBe(false);
  });

  it("sorts eligible provider routes after their cached account was evicted", () => {
    const state = createControlPlaneState({
      now: () => NOW,
      attemptIdFactory: () => "attempt",
      shardCount: 1,
    });
    state.providers.set("provider", {
      id: "provider",
      name: "provider",
      defaultCommandId: "provider-command",
    });
    state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
    });
    state.commands.set("provider-command", {
      id: "provider-command",
      name: "provider command",
      argv: ["tool"],
      appendPrompt: true,
      providerId: "provider",
    });
    for (const hostId of ["host-a", "host-b"]) {
      const id = `worktree-${hostId}`;
      state.worktrees.set(id, { ...worktree, id, name: id, hostId });
      const connectionId = `connection-${hostId}`;
      state.connections.set(connectionId, {
        hostId,
        connectionId,
        type: "host",
        connectedAt: NOW,
        lastHeartbeatAt: NOW,
        capabilities: [],
        repositoryIds: ["repo"],
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        protocolVersion: 1,
        providerAccountReadiness: [
          { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
        ],
      });
      state.hostConnection.set(hostId, connectionId);
      state.hostInventories.set(hostId, {
        hostId,
        repositories: [{ id: "repo", path: "/repo", worktrees: [] }],
        providerAccounts: [{ providerAccountId: "account" }],
        commandProfiles: {},
        updatedAt: NOW,
      });
    }
    state.sessions.set("s", session({ target: { commandId: "provider-command" } }));
    state.providerAccounts.get = () => undefined;

    expect(assignQueued(state)).toHaveLength(1);
  });

  it("assigns durably after the claimed provider account disappears", async () => {
    const state = createControlPlaneState({
      now: () => NOW,
      attemptIdFactory: () => "attempt",
      shardCount: 1,
    });
    state.providers.set("provider", {
      id: "provider",
      name: "provider",
      defaultCommandId: "provider-command",
    });
    state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
    });
    state.commands.set("provider-command", {
      id: "provider-command",
      name: "provider command",
      argv: ["tool"],
      appendPrompt: true,
      providerId: "provider",
    });
    state.worktrees.set("w", worktree);
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 1,
      providerAccountReadiness: [
        { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
      ],
    });
    state.hostConnection.set("host", "connection");
    state.hostInventories.set("host", {
      hostId: "host",
      repositories: [{ id: "repo", path: "/repo", worktrees: [] }],
      providerAccounts: [{ providerAccountId: "account" }],
      commandProfiles: {},
      updatedAt: NOW,
    });
    state.sessions.set(
      "s",
      session({
        target: { commandId: "provider-command" },
        targetLabels: ["provider-command"],
      }),
    );
    setDurableReadStorage(state, {
      expireQueuedSession: async () => false,
      tryAssignSession: async () => {
        state.providerAccounts.delete("account");
        return true;
      },
    });
    await expect(assignQueuedDurable(state)).resolves.toMatchObject([
      { session: { resolvedRoute: { providerAccountId: "account" } } },
    ]);
    expect(state.providerAccounts.has("account")).toBe(false);
  });
});
