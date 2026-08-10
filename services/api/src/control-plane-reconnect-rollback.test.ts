import { describe, expect, it, vi } from "vitest";

import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { ControlPlane } from "./control-plane.ts";
import {
  restoreConfirmedSessions,
  type ReconnectConfirmation,
} from "./control-plane-reconnect-rollback.ts";

function confirmation(id: string, opts: { withPriorFence?: boolean } = {}): ReconnectConfirmation {
  const session: SessionRecord = {
    id,
    repositoryId: "r",
    prompt: "p",
    targetLabel: "t",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: "t",
    hostId: "h",
    worktreeId: `w-${id}`,
    ackReceivedAt: "t",
    ...(opts.withPriorFence
      ? {
          reconnectDeadlineAt: "2026-01-01T00:00:00.000Z",
          assignmentConnectionId: "prior-assignment",
        }
      : {}),
  };
  const worktree: WorktreeRecord = {
    id: `w-${id}`,
    name: `w-${id}`,
    hostId: "h",
    repositoryId: "r",
    path: `/w-${id}`,
    labels: [],
    status: "busy",
    online: false,
    currentSessionId: id,
    ...(opts.withPriorFence ? { connectionId: "prior-worktree" } : {}),
  };
  return { session, worktree };
}

describe("restoreConfirmedSessions", () => {
  it("does nothing for an empty rollback and restores in-memory confirmations", async () => {
    const plane = new ControlPlane();
    await restoreConfirmedSessions(plane.state, "h", undefined, []);
    expect(plane.state.sessions).toEqual(new Map());
    expect(plane.state.worktrees).toEqual(new Map());

    const prior = confirmation("local", { withPriorFence: true });
    plane.state.sessions.set(prior.session.id, { ...prior.session, hostId: null });
    plane.state.worktrees.set(prior.worktree.id, { ...prior.worktree, online: true });
    await restoreConfirmedSessions(plane.state, "h", undefined, [prior]);

    expect(plane.state.sessions.get("local")).toEqual(prior.session);
    expect(plane.state.worktrees.get("w-local")).toEqual(prior.worktree);
  });

  it("requires a lease before attempting durable restoration", async () => {
    const plane = new ControlPlane();
    const restoreReconnectPending = vi.fn();
    plane.state.storage = { restoreReconnectPending } as never;

    await restoreConfirmedSessions(plane.state, "h", undefined, [confirmation("unleased")]);

    expect(restoreReconnectPending).not.toHaveBeenCalled();
  });

  it("restores successful durable rows in reverse order and leaves rejected rows cached", async () => {
    const plane = new ControlPlane();
    const plain = confirmation("plain");
    const fenced = confirmation("fenced", { withPriorFence: true });
    const restoreReconnectPending = vi.fn(
      async (opts: { sessionId: string }) => opts.sessionId === "fenced",
    );
    plane.state.storage = { restoreReconnectPending } as never;

    await restoreConfirmedSessions(plane.state, "h", "current", [fenced, plain]);

    expect(restoreReconnectPending).toHaveBeenCalledTimes(2);
    expect(restoreReconnectPending).toHaveBeenNthCalledWith(1, {
      sessionId: "plain",
      hostId: "h",
      worktreeId: "w-plain",
      connectionId: "current",
    });
    expect(restoreReconnectPending).toHaveBeenNthCalledWith(2, {
      sessionId: "fenced",
      hostId: "h",
      worktreeId: "w-fenced",
      connectionId: "current",
      previousDeadlineAt: "2026-01-01T00:00:00.000Z",
      previousAssignmentConnectionId: "prior-assignment",
      previousWorktreeConnectionId: "prior-worktree",
    });
    expect(plane.state.sessions.has("plain")).toBe(false);
    expect(plane.state.worktrees.has("w-plain")).toBe(false);
    expect(plane.state.sessions.get("fenced")).toEqual(fenced.session);
    expect(plane.state.worktrees.get("w-fenced")).toEqual(fenced.worktree);
  });
});
