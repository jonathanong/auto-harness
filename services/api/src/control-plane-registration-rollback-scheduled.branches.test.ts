import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { protectScheduledRunsForFailedRegistration } from "./control-plane-registration-rollback-scheduled.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    commandId: "cmd",
    targetLabel: "cmd",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    hostId: "host",
    attemptId: "attempt",
    assignmentConnectionId: "old",
    mainCheckoutLease: true,
    ackReceivedAt: NOW,
    ...over,
  };
}

function stateWithStorage(methods: Record<string, unknown> = {}) {
  const state = createControlPlaneState({ now: () => NOW, reconnectGraceMs: 100 });
  state.storage = methods as never;
  return state;
}

describe("scheduled registration rollback branch coverage", () => {
  it("skips non-running, unleased, and unassigned sessions", async () => {
    const state = stateWithStorage({ listSessionsByHost: async () => [] });
    const rows = [
      session({ id: "queued", status: "queued" }),
      session({ id: "no-lease", mainCheckoutLease: undefined }),
      session({ id: "no-assignment", assignmentConnectionId: undefined }),
    ];
    state.storage = {
      listSessionsByHost: async () => rows,
      markMainCheckoutReconnectPending: async () => false,
      releaseMainCheckoutSession: async () => false,
      getSession: async () => null,
    } as never;
    await expect(protectScheduledRunsForFailedRegistration(state, "host")).resolves.toBeUndefined();
    expect(state.sessions.size).toBe(0);
  });

  it("protects a candidate-owned run during replacement rollback", async () => {
    const state = stateWithStorage({
      listSessionsByHost: async () => [session({ assignmentConnectionId: "candidate" })],
      markMainCheckoutReconnectPending: async () => true,
    });
    await protectScheduledRunsForFailedRegistration(state, "host");
    expect(state.sessions.get("s")).toMatchObject({
      reconnectDeadlineAt: "2026-01-01T00:00:00.100Z",
    });
  });

  it("falls back to the local session map and preserves an existing deadline", async () => {
    const state = createControlPlaneState({ now: () => NOW, reconnectGraceMs: 100 });
    state.storage = {} as never;
    const row = session({ reconnectDeadlineAt: "later" });
    state.sessions.set(row.id, row);
    await protectScheduledRunsForFailedRegistration(state, "host");
    expect(state.sessions.get(row.id)).toEqual(row);
  });

  it("marks an acknowledged run for reconnect when no deadline exists", async () => {
    let marked: Record<string, unknown> | undefined;
    const state = stateWithStorage({
      listSessionsByHost: async () => [session()],
      markMainCheckoutReconnectPending: async (input: Record<string, unknown>) => {
        marked = input;
        return true;
      },
    });
    await protectScheduledRunsForFailedRegistration(state, "host");
    expect(marked).toMatchObject({
      sessionId: "s",
      connectionId: "old",
      deadlineAt: `${NOW.slice(0, 19)}.100Z`,
    });
    expect(state.sessions.get("s")).toMatchObject({
      reconnectDeadlineAt: "2026-01-01T00:00:00.100Z",
    });
  });

  it("falls back to release when marking fails, queues the run, and clears its ACK", async () => {
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    const state = stateWithStorage({
      listSessionsByHost: async () => [session()],
      markMainCheckoutReconnectPending: async () => false,
      releaseMainCheckoutSession: async () => true,
      getSession: async () => null,
      releaseLegacyHostAssignment,
    });
    state.pendingAcks.set("s", { sessionId: "s", worktreeId: null, assignedAtMs: 0 });
    await protectScheduledRunsForFailedRegistration(state, "host");
    expect(state.sessions.get("s")).toMatchObject({ status: "queued", hostId: null });
    expect(state.pendingAcks.has("s")).toBe(false);
    expect(releaseLegacyHostAssignment).toHaveBeenCalledWith({
      sessionId: "s",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "old",
    });
  });

  it("does nothing when release loses the lease, but throws if the lease is still current", async () => {
    const unchanged = stateWithStorage({
      listSessionsByHost: async () => [session()],
      markMainCheckoutReconnectPending: async () => false,
      releaseMainCheckoutSession: async () => false,
      getSession: async () => null,
    });
    await expect(
      protectScheduledRunsForFailedRegistration(unchanged, "host"),
    ).resolves.toBeUndefined();

    const current = stateWithStorage({
      listSessionsByHost: async () => [session()],
      markMainCheckoutReconnectPending: async () => false,
      releaseMainCheckoutSession: async () => false,
      getSession: async () => session(),
    });
    await expect(protectScheduledRunsForFailedRegistration(current, "host")).rejects.toThrow(
      "could not protect scheduled session s",
    );
  });
});
