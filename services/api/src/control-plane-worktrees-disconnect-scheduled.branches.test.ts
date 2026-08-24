import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { disconnectScheduledMainCheckouts } from "./control-plane-worktrees-disconnect-scheduled.ts";
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
    assignmentConnectionId: "old",
    mainCheckoutLease: true,
    ...over,
  };
}

function state() {
  return createControlPlaneState({ now: () => NOW, reconnectGraceMs: 100 });
}

describe("scheduled disconnect branch coverage", () => {
  it("uses the local map and skips unrelated sessions", async () => {
    const current = state();
    current.sessions.set("s", session({ ackReceivedAt: undefined }));
    current.sessions.set("queued", session({ id: "queued", status: "queued" }));
    current.sessions.set("other-host", session({ id: "other-host", hostId: "other" }));
    const requeued: string[] = [];
    current.storage = { releaseMainCheckoutSession: async () => true } as never;
    await disconnectScheduledMainCheckouts(current, "host", "old", "gone", requeued);
    expect(requeued).toEqual(["s"]);
    expect(current.sessions.get("s")).toMatchObject({ status: "queued", hostId: null });
  });

  it("requeues an unacknowledged durable run and clears pending ACK state", async () => {
    const current = state();
    const calls: Record<string, unknown>[] = [];
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    current.storage = {
      listSessionsByHost: async () => [session({ ackReceivedAt: undefined })],
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        calls.push(input);
        return true;
      },
      markMainCheckoutReconnectPending: async () => false,
      releaseLegacyHostAssignment,
    } as never;
    current.pendingAcks.set("s", { sessionId: "s", worktreeId: null, assignedAtMs: 0 });
    const requeued: string[] = [];
    await disconnectScheduledMainCheckouts(current, "host", "new", "lost", requeued);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ connectionId: "new", reason: "lost", status: "queued" });
    expect(requeued).toEqual(["s"]);
    expect(current.pendingAcks.has("s")).toBe(false);
    expect(releaseLegacyHostAssignment).toHaveBeenCalledWith({
      hostId: "host",
      connectionId: "old",
    });
  });

  it("leaves an unacknowledged run alone when the conditional release loses", async () => {
    const current = state();
    const row = session({ ackReceivedAt: undefined });
    current.storage = {
      listSessionsByHost: async () => [row],
      releaseMainCheckoutSession: async () => false,
    } as never;
    const requeued: string[] = [];
    await disconnectScheduledMainCheckouts(current, "host", "old", "lost", requeued);
    expect(requeued).toEqual([]);
    expect(current.sessions.size).toBe(0);
  });

  it("marks an acknowledged run for reconnect, including the failed mark path", async () => {
    const current = state();
    const row = session({ ackReceivedAt: NOW });
    let marks = 0;
    current.storage = {
      listSessionsByHost: async () => [row],
      markMainCheckoutReconnectPending: async (input: Record<string, unknown>) => {
        marks++;
        expect(input).toMatchObject({
          sessionId: "s",
          connectionId: "old",
          deadlineAt: "2026-01-01T00:00:00.100Z",
        });
        return marks === 1;
      },
    } as never;
    const first: string[] = [];
    await disconnectScheduledMainCheckouts(current, "host", "old", "lost", first);
    expect(current.sessions.get("s")).toMatchObject({
      reconnectDeadlineAt: "2026-01-01T00:00:00.100Z",
    });

    current.sessions.delete("s");
    const second: string[] = [];
    await disconnectScheduledMainCheckouts(current, "host", "old", "lost", second);
    expect(second).toEqual([]);
    expect(marks).toBe(2);
  });
});
