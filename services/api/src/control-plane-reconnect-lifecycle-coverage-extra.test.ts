import { describe, expect, it } from "vitest";

import { reclaimStaleHosts } from "./control-plane-lifecycle.ts";
import { reconcileHostRunningSessions } from "./control-plane-reconnect.ts";
import { reclaimScheduledReconnect } from "./control-plane-reconnect-scheduled.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { offlineHostAndRequeueDurableImpl } from "./control-plane-worktrees-disconnect.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
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

function worktree(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "w",
    name: "w",
    hostId: "host",
    repositoryId: "repo",
    path: "/repo/w",
    labels: [],
    status: "busy",
    online: false,
    currentSessionId: "ordinary",
    ...over,
  };
}

describe("reconnect and lifecycle residual coverage", () => {
  it("reports an unacknowledged stale session once", () => {
    const state = createControlPlaneState({ heartbeatStaleMs: 1, now: () => NOW });
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: ["repo"],
    });
    state.hostConnection.set("host", "connection");
    state.sessions.set("ordinary", session("ordinary"));
    state.worktrees.set("w", worktree());

    expect(reclaimStaleHosts(state, Date.parse(NOW) + 2)).toEqual(["ordinary"]);
  });

  it("rolls back an earlier worktree confirmation when a scheduled report loses", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.hostConnection.set("host", "new");
    const ordinary = session("ordinary", {
      ackReceivedAt: NOW,
      reconnectDeadlineAt: "2026-01-01T00:01:00.000Z",
      assignmentConnectionId: "old",
    });
    const scheduled = session("scheduled", {
      type: "scheduled",
      source: "schedule",
      worktreeId: null,
      ackReceivedAt: NOW,
      mainCheckoutLease: true,
      assignmentConnectionId: "old",
    });
    const wt = worktree({ connectionId: "old" });
    state.storage = {
      getSession: async (id: string) => (id === "ordinary" ? ordinary : scheduled),
      getWorktree: async () => wt,
      confirmReconnect: async () => true,
      confirmMainCheckoutReconnect: async () => false,
      restoreReconnectPending: async () => true,
    } as never;

    await expect(
      reconcileHostRunningSessions(state, "host", ["ordinary", "scheduled"]),
    ).resolves.toBe(false);
    expect(state.sessions.get("ordinary")?.reconnectDeadlineAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("uses a cancelled scheduled session's explicit reason and concurrency fence", async () => {
    const state = createControlPlaneState();
    const row = session("cancelled", {
      type: "scheduled",
      source: "schedule",
      status: "cancelled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
      errorMessage: "operator stop",
      concurrencyId: "nightly",
    });
    let options: Record<string, unknown> = {};
    state.storage = {
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        options = input;
        return true;
      },
    } as never;
    expect(await reclaimScheduledReconnect(state, row, [])).toBe(true);
    expect(options).toMatchObject({
      reason: "operator stop",
      expectedStatus: "cancelled",
      concurrencyId: "nightly",
    });
  });

  it("uses the default reason for a cancelled scheduled reconnect", async () => {
    const state = createControlPlaneState();
    const row = session("cancelled", {
      type: "scheduled",
      source: "schedule",
      status: "cancelled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    let reason: unknown;
    state.storage = {
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        reason = input.reason;
        return true;
      },
    } as never;
    await reclaimScheduledReconnect(state, row, []);
    expect(reason).toBe("cancelled by operator");
  });

  it("carries a cancelled worktree session's concurrency lock through disconnect", async () => {
    const state = createControlPlaneState();
    const row = session("cancelled", { status: "cancelled", concurrencyId: "one" });
    let options: Record<string, unknown> = {};
    state.storage = {
      listWorktreesByHost: async () => [worktree({ currentSessionId: row.id })],
      getSession: async () => row,
      releaseCancelledSessionWorktree: async (input: Record<string, unknown>) => {
        options = input;
        return true;
      },
    } as never;
    await offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []);
    expect(options).toMatchObject({ concurrencyId: "one" });
  });
});
