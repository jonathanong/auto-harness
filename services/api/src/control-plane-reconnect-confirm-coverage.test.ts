import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  confirmReportedSession,
  confirmReportedWorkspaceSession,
  ignoreStaleReconnectClaim,
} from "./control-plane-reconnect-confirm.ts";
import type { SessionRecord, WorkspaceSlotRecord, WorktreeRecord } from "./db/types.ts";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    hostId: "host",
    attemptId: "attempt",
    ackReceivedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function worktree(): WorktreeRecord {
  return {
    id: "worktree",
    name: "worktree",
    hostId: "host",
    repositoryId: "repo",
    path: "/repo/worktree",
    labels: [],
    status: "busy",
    online: false,
    currentSessionId: "session",
  };
}

function slot(): WorkspaceSlotRecord {
  return {
    id: "slot",
    name: "slot",
    path: "/workspace/slot",
    hostId: "host",
    workspacePoolId: "pool",
    status: "busy",
    online: false,
    currentSessionId: "session",
  };
}

describe("reconnect confirmation helpers", () => {
  it("ignores only a stale attempt and rejects incomplete claims", () => {
    const state = createControlPlaneState();
    expect(ignoreStaleReconnectClaim(state, null, "attempt")).toBe(false);
    expect(ignoreStaleReconnectClaim(state, session(), undefined)).toBe(false);
    expect(ignoreStaleReconnectClaim(state, session(), "attempt")).toBe(false);
    expect(ignoreStaleReconnectClaim(state, session(), "stale-attempt")).toBe(true);
  });

  it("confirms local reports without inventing a connection id", async () => {
    const state = createControlPlaneState();
    const row = session({ reconnectDeadlineAt: undefined });
    const reportedWorktree = worktree();

    await expect(
      confirmReportedSession(state, row, reportedWorktree, "host", undefined),
    ).resolves.toBe(true);
    expect(state.sessions.get(row.id)).not.toHaveProperty("reconnectDeadlineAt");
    expect(state.worktrees.get(reportedWorktree.id)).toMatchObject({ online: true });
    expect(state.worktrees.get(reportedWorktree.id)).not.toHaveProperty("connectionId");
  });

  it("fences durable worktree confirms and preserves state on a lost claim", async () => {
    const state = createControlPlaneState();
    const row = session({ reconnectDeadlineAt: "2026-01-01T00:01:00.000Z" });
    const reportedWorktree = worktree();
    const confirmReconnect = vi.fn(async () => true);
    state.storage = { confirmReconnect } as never;

    await expect(
      confirmReportedSession(state, row, reportedWorktree, "host", undefined),
    ).resolves.toBe(false);
    await expect(
      confirmReportedSession(state, row, reportedWorktree, "host", "connection"),
    ).resolves.toBe(true);
    expect(confirmReconnect).toHaveBeenCalledWith({
      sessionId: row.id,
      hostId: "host",
      worktreeId: reportedWorktree.id,
      deadlineAt: row.reconnectDeadlineAt,
      connectionId: "connection",
    });
    expect(state.worktrees.get(reportedWorktree.id)).toMatchObject({
      online: true,
      connectionId: "connection",
    });

    state.storage = { confirmReconnect: async () => false } as never;
    await expect(
      confirmReportedSession(state, row, reportedWorktree, "host", "replacement"),
    ).resolves.toBe(false);
    expect(state.worktrees.get(reportedWorktree.id)?.connectionId).toBe("connection");

    const noDeadline = session({ id: "without-deadline", reconnectDeadlineAt: undefined });
    const anotherWorktree = {
      ...worktree(),
      id: "another-worktree",
      currentSessionId: noDeadline.id,
    };
    state.storage = { confirmReconnect } as never;
    await expect(
      confirmReportedSession(state, noDeadline, anotherWorktree, "host", "connection"),
    ).resolves.toBe(true);
    expect(confirmReconnect).toHaveBeenLastCalledWith({
      sessionId: noDeadline.id,
      hostId: "host",
      worktreeId: anotherWorktree.id,
      connectionId: "connection",
    });
  });

  it("requires a workspace confirm capability and only caches a fenced success", async () => {
    const state = createControlPlaneState();
    const row = session({
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      worktreeId: null,
      reconnectDeadlineAt: "2026-01-01T00:01:00.000Z",
    });
    const reportedSlot = slot();
    state.storage = {} as never;
    await expect(
      confirmReportedWorkspaceSession(state, row, reportedSlot, "host", "connection"),
    ).resolves.toBe(false);

    const confirmWorkspaceReconnect = vi.fn(async () => true);
    state.storage = { confirmWorkspaceReconnect } as never;
    await expect(
      confirmReportedWorkspaceSession(state, row, reportedSlot, "host", undefined),
    ).resolves.toBe(false);
    await expect(
      confirmReportedWorkspaceSession(state, row, reportedSlot, "host", "connection"),
    ).resolves.toBe(true);
    expect(confirmWorkspaceReconnect).toHaveBeenCalledWith({
      sessionId: row.id,
      hostId: "host",
      workspaceSlotId: reportedSlot.id,
      deadlineAt: row.reconnectDeadlineAt,
      connectionId: "connection",
    });
    expect(state.workspaceSlots.get(reportedSlot.id)).toMatchObject({
      online: true,
      connectionId: "connection",
    });

    const local = createControlPlaneState();
    const localRow = { ...row, id: "local-workspace", reconnectDeadlineAt: undefined };
    const localSlot = { ...reportedSlot, id: "local-slot", currentSessionId: localRow.id };
    await expect(
      confirmReportedWorkspaceSession(local, localRow, localSlot, "host", undefined),
    ).resolves.toBe(true);
    expect(local.workspaceSlots.get(localSlot.id)).toMatchObject({ online: true });
    expect(local.workspaceSlots.get(localSlot.id)).not.toHaveProperty("connectionId");
  });
});
