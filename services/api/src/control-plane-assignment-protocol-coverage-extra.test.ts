import { describe, expect, it } from "vitest";

import { assignQueuedDurable } from "./control-plane-assign.ts";
import { assignScheduledQueuedDurable } from "./control-plane-scheduled-assign.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { ConnectionRecord } from "./db/plane-storage-types.ts";
import type { SessionRecord } from "./db/types.ts";
import { workspacePlane, createWorkspaceSession } from "./test-helpers/workspace-session.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function scheduledState(capabilities: string[] = ["scheduled-main-checkout"]) {
  const state = createControlPlaneState({
    now: () => NOW,
    attemptIdFactory: () => "attempt",
    shardCount: 1,
  });
  state.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  state.hostInventories.set("host", {
    hostId: "host",
    repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
    providerAccounts: [],
    commandProfiles: {},
    updatedAt: NOW,
  });
  const connection: ConnectionRecord = {
    hostId: "host",
    connectionId: "connection",
    type: "host",
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    capabilities,
    repositoryIds: ["repo"],
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    protocolVersion: 7,
  };
  state.connections.set(connection.connectionId, connection);
  state.hostConnection.set(connection.hostId, connection.connectionId);
  const session: SessionRecord = {
    id: "scheduled",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    principalId: "system",
  };
  state.sessions.set(session.id, session);
  return state;
}

describe("assignment protocol and optional-field coverage", () => {
  it("serializes a scheduled assignment credential on both durable and wire paths", async () => {
    const state = scheduledState(["scheduled-main-checkout", "session-spawn"]);
    const messages: unknown[] = [];
    state.onHostMessage = (_hostId, message) => messages.push(message);
    state.storage = {
      getMainCheckoutCursor: async () => "",
      ensureMainCheckoutLeaseMap: async () => true,
      tryAssignMainCheckoutSession: async () => true,
    } as never;

    await expect(
      assignScheduledQueuedDurable(state, undefined, { readModelLoaded: true }),
    ).resolves.toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "session:assign",
      sessionType: "scheduled",
      sessionApiKey: expect.stringMatching(/^hns_session_/),
    });
    expect(state.sessions.get("scheduled")).toMatchObject({
      status: "running",
      sessionApiKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("keeps scheduled assignment queued when a candidate connection is stale", async () => {
    const state = scheduledState();
    const originalGet = state.hostConnection.get.bind(state.hostConnection);
    let reads = 0;
    state.hostConnection.get = (hostId) => {
      reads += 1;
      return reads > 3 ? "newer-connection" : originalGet(hostId);
    };

    await expect(assignScheduledQueuedDurable(state)).resolves.toEqual([]);
    expect(state.sessions.get("scheduled")).toMatchObject({ status: "queued" });
  });

  it("handles a missing workspace setup pool and account recency safely", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    plane.state.workspacePools.clear();
    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toHaveLength(1);
    expect(plane.getSession(session.id)).toMatchObject({ status: "running" });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({ status: "busy" });
  });

  it("skips a prompt candidate whose host connection disappears", async () => {
    const state = createControlPlaneState({ now: () => NOW, shardCount: 1 });
    state.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "/repo",
      defaultBranch: "main",
      admissionState: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
    });
    state.sessions.set("prompt", {
      id: "prompt",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
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
    });
    state.worktrees.set("worktree", {
      id: "worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo/worktree",
      labels: [],
      status: "idle",
      online: true,
      connectionId: "connection",
    });
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 1,
    });
    state.hostConnection.set("host", "connection");
    const originalGet = state.hostConnection.get.bind(state.hostConnection);
    let reads = 0;
    state.hostConnection.get = (hostId) => {
      reads += 1;
      return reads < 5 ? originalGet(hostId) : undefined;
    };
    state.storage = {
      listWorktreesForRepo: async () => [state.worktrees.get("worktree")!],
      tryAssignSession: async () => true,
    } as never;

    await expect(assignQueuedDurable(state, undefined, { readModelLoaded: true })).resolves.toEqual(
      [],
    );
    expect(state.sessions.get("prompt")).toMatchObject({ status: "queued" });
  });
});
