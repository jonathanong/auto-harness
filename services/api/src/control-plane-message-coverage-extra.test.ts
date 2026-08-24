import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { getLogs, handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
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

function state(row: SessionRecord) {
  const current = createControlPlaneState({ now: () => NOW, shardCount: 1 });
  current.sessions.set(row.id, row);
  current.commands.set("cmd", {
    id: "cmd",
    name: "cmd",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  return current;
}

describe("host message residual coverage", () => {
  it("uses the keepalive host identity when fencing a durable heartbeat", async () => {
    const current = state(session());
    current.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: ["repo"],
    });
    current.hostConnection.set("host", "connection");
    setDurableReadStorage(current, {
      getHostLock: async () => "connection",
      heartbeatConnection: async () => true,
    });
    await expect(
      handleHostMessageDurable(
        current,
        { type: "host:keepalive", hostId: "host", at: NOW },
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps a conditionally lost durable acknowledgement idempotent", async () => {
    const row = session({ assignmentSentAt: NOW });
    const current = state(row);
    setDurableReadStorage(current, {
      getSession: async () => row,
      acknowledgeSession: async () => false,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "session:ack",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("persists providerless suppression even when the run has no worktree", async () => {
    const row = session({
      worktreeId: null,
      suppressedTargetIndexes: [2],
      resolvedRoute: {
        targetIndex: 1,
        commandId: "cmd",
        hostId: "host",
        worktreeId: "w",
        attemptId: "attempt",
      },
    });
    const current = state(row);
    setDurableReadStorage(current, {
      getSession: async () => row,
      finishSession: async () => true,
    });
    await handleHostMessageDurable(current, {
      type: "session:status",
      sessionId: "s",
      worktreeId: null,
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(current.sessions.get("s")).toMatchObject({
      status: "queued",
      suppressedTargetIndexes: [2, 1],
    });
  });

  it("extends an existing providerless suppression list in memory", () => {
    const row = session({
      suppressedTargetIndexes: [2],
      resolvedRoute: {
        targetIndex: 1,
        commandId: "cmd",
        hostId: "host",
        worktreeId: "w",
        attemptId: "attempt",
      },
    });
    const current = state(row);
    expect(
      handleHostMessage(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).toEqual({ ok: true });
    expect(current.sessions.get("s")?.suppressedTargetIndexes).toEqual([2, 1]);
    expect(getLogs(current, "missing")).toEqual([]);
  });

  it("reports a fenced drain that lost the durable mark", async () => {
    const current = state(session());
    setDurableReadStorage(current, {
      getHostLock: async () => "connection",
      markHostDraining: async () => false,
    });
    await expect(
      handleHostMessageDurable(
        current,
        { type: "host:status", hostId: "host", draining: true },
        "connection",
      ),
    ).resolves.toEqual({ ok: false, error: "stale host connection" });
  });
});
