/* eslint-disable max-lines -- empty-worker usage-limit fixtures share one catalog. */
import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { ConnectionRecord } from "./db/plane-storage-types.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const liveConnection: ConnectionRecord = {
  connectionId: "connection",
  type: "host",
  hostId: "host",
  connectedAt: NOW,
  lastHeartbeatAt: NOW,
  capabilities: [],
  repositoryIds: ["repo"],
  runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
  protocolVersion: HOST_PROTOCOL_VERSION,
  providerAccountReadiness: [
    { providerAccountId: "acct-codex", ready: true, fingerprint: "a".repeat(64) },
    { providerAccountId: "acct-cursor", ready: true, fingerprint: "b".repeat(64) },
  ],
};

function runningSession(): SessionRecord {
  return {
    id: "sess",
    repositoryId: "repo",
    prompt: "fix it",
    target: { commandId: "cmd-codex" },
    fallbacks: [{ commandId: "cmd-cursor" }],
    targetDisplayNames: ["codex", "cursor"],
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
    worktreeId: "wt",
    attemptId: "attempt-1",
    assignmentConnectionId: "connection",
    assignmentSentAt: NOW,
    startedAt: NOW,
    ackReceivedAt: NOW,
    resolvedRoute: {
      targetIndex: 0,
      providerId: "prov-codex",
      providerAccountId: "acct-codex",
      commandId: "cmd-codex",
      hostId: "host",
      worktreeId: "wt",
      attemptId: "attempt-1",
    },
  };
}

function emptyWorkerState() {
  const state = createControlPlaneState({
    now: () => NOW,
    attemptIdFactory: () => "attempt-2",
    shardCount: 1,
  });
  state.repositories.set("repo", {
    id: "repo",
    name: "repo",
    url: "/repo",
    defaultBranch: "main",
    admissionState: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  state.providers.set("prov-codex", {
    id: "prov-codex",
    name: "codex",
    defaultCommandId: "cmd-codex",
  });
  state.providers.set("prov-cursor", {
    id: "prov-cursor",
    name: "cursor",
    defaultCommandId: "cmd-cursor",
  });
  state.providerAccounts.set("acct-codex", {
    id: "acct-codex",
    providerId: "prov-codex",
    label: "codex@example.test",
    usageLimitCooldownSeconds: 60,
    maxConcurrentSessions: 1,
  });
  state.providerAccounts.set("acct-cursor", {
    id: "acct-cursor",
    providerId: "prov-cursor",
    label: "cursor@example.test",
    usageLimitCooldownSeconds: 60,
    maxConcurrentSessions: 1,
  });
  state.commands.set("cmd-codex", {
    id: "cmd-codex",
    name: "codex-exec",
    argv: ["codex", "exec"],
    appendPrompt: true,
    providerId: "prov-codex",
  });
  state.commands.set("cmd-cursor", {
    id: "cmd-cursor",
    name: "cursor-print",
    argv: ["cursor-agent", "--print"],
    appendPrompt: true,
    providerId: "prov-cursor",
  });
  const worktree: WorktreeRecord = {
    id: "wt",
    name: "wt",
    hostId: "host",
    repositoryId: "repo",
    path: "/wt",
    labels: [],
    status: "busy",
    online: true,
    currentSessionId: "sess",
  };
  state.worktrees.set("wt", worktree);
  state.hostInventories.set("host", {
    hostId: "host",
    version: 0,
    repositories: [
      {
        id: "repo",
        path: "/repo",
        defaultBranch: "main",
        worktrees: [{ id: "wt", name: "wt", path: "/wt", labels: [] }],
      },
    ],
    providerAccounts: [{ providerAccountId: "acct-codex" }, { providerAccountId: "acct-cursor" }],
    commandProfiles: {},
    updatedAt: NOW,
  });
  state.sessions.set("sess", runningSession());
  return state;
}

function usageLimitStatus() {
  return {
    type: "session:status" as const,
    sessionId: "sess",
    worktreeId: "wt",
    attemptId: "attempt-1",
    status: "failed" as const,
    errorCode: "usage_limit",
    errorMessage: "Usage limit detected",
  };
}

describe("durable usage-limit fallback on an empty worker", () => {
  it("assigns the next provider when the status worker has no in-memory sockets", async () => {
    const state = emptyWorkerState();
    setDurableReadStorage(state, {
      getHostLock: async () => "connection",
      getConnection: async (connectionId: string) =>
        connectionId === "connection" ? liveConnection : null,
      listConnections: async () => [],
      requeueUsageLimitedSession: async () => true,
      tryAssignSession: async () => true,
      expireQueuedSession: async () => false,
    });

    expect((await handleHostMessageDurable(state, usageLimitStatus(), "connection")).ok).toBe(true);
    expect(state.sessions.get("sess")).toMatchObject({
      status: "running",
      hostId: "host",
      worktreeId: "wt",
      resolvedRoute: {
        targetIndex: 1,
        providerAccountId: "acct-cursor",
        commandId: "cmd-cursor",
      },
    });
    expect(state.providerAccounts.get("acct-codex")?.usageLimitedUntil).toBe(
      "2026-01-01T00:01:00.000Z",
    );
  });

  it("assigns the next provider from a listed live socket when create has no source connection", async () => {
    const state = emptyWorkerState();
    setDurableReadStorage(state, {
      getConnection: async (connectionId: string) =>
        connectionId === "connection" ? liveConnection : null,
      listConnections: async () => [liveConnection],
      requeueUsageLimitedSession: async () => true,
      tryAssignSession: async () => true,
      expireQueuedSession: async () => false,
    });

    expect((await handleHostMessageDurable(state, usageLimitStatus())).ok).toBe(true);
    expect(state.sessions.get("sess")?.resolvedRoute).toMatchObject({
      targetIndex: 1,
      providerAccountId: "acct-cursor",
    });
  });

  it("stays queued when the empty worker cannot see any live host", async () => {
    const state = emptyWorkerState();
    setDurableReadStorage(state, {
      listConnections: async () => [],
      requeueUsageLimitedSession: async () => true,
      tryAssignSession: async () => true,
      expireQueuedSession: async () => false,
    });

    expect((await handleHostMessageDurable(state, usageLimitStatus())).ok).toBe(true);
    expect(state.sessions.get("sess")).toMatchObject({
      status: "queued",
      hostId: null,
      errorCode: "usage_limit",
    });
    expect(state.sessions.get("sess")?.assignmentConnectionId).toBeUndefined();
  });
});
