import { describe, expect, it, vi } from "vitest";

import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

function legacySession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "later",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: "now",
    hostId: "host",
    assignmentConnectionId: "connection",
    resolvedRoute: {
      targetIndex: 0,
      providerAccountId: "account",
      commandId: "command",
      hostId: "host",
      worktreeId: "worktree",
      attemptId: "attempt",
    },
    ...over,
  };
}

describe("legacy host assignment release", () => {
  it("reconciles only a fenced, unpersisted legacy lease", async () => {
    const state = createControlPlaneState();
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    state.storage = { releaseLegacyHostAssignment } as never;

    await releaseLegacyHostAssignmentAfterDurableTransition(state, legacySession());
    await releaseLegacyHostAssignmentAfterDurableTransition(
      state,
      legacySession({ hostAssignmentLease: { hostId: "host" } }),
    );
    await releaseLegacyHostAssignmentAfterDurableTransition(
      state,
      legacySession({ assignmentConnectionId: undefined }),
    );

    expect(releaseLegacyHostAssignment).toHaveBeenCalledTimes(1);
    expect(releaseLegacyHostAssignment).toHaveBeenCalledWith({
      sessionId: "session",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "connection",
    });
  });

  it("keeps a durable transition successful when the best-effort repair fails", async () => {
    const state = createControlPlaneState();
    const releaseLegacyHostAssignment = vi.fn(async () => {
      throw new Error("host unavailable");
    });
    state.storage = { releaseLegacyHostAssignment } as never;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        releaseLegacyHostAssignmentAfterDurableTransition(state, legacySession()),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "legacy host assignment release failed",
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("retries against a replacement fence with a per-session release marker", async () => {
    const state = createControlPlaneState();
    const releaseLegacyHostAssignment = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const getHostLockState = vi.fn(async () => ({
      connectionId: "replacement",
      draining: false,
    }));
    state.storage = { releaseLegacyHostAssignment, getHostLockState } as never;

    await releaseLegacyHostAssignmentAfterDurableTransition(state, legacySession());

    expect(releaseLegacyHostAssignment).toHaveBeenNthCalledWith(2, {
      sessionId: "session",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "replacement",
    });
  });

  it("stops retrying when the replacement fence is absent or repeats", async () => {
    const state = createControlPlaneState();
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    const getHostLockState = vi
      .fn<() => Promise<{ connectionId: string | null; draining: boolean }>>()
      .mockResolvedValueOnce({ connectionId: "replacement", draining: false })
      .mockResolvedValueOnce({ connectionId: "replacement", draining: false });
    state.storage = { releaseLegacyHostAssignment, getHostLockState } as never;
    await releaseLegacyHostAssignmentAfterDurableTransition(state, legacySession());
    expect(releaseLegacyHostAssignment).toHaveBeenCalledTimes(2);

    getHostLockState.mockResolvedValueOnce({ connectionId: null, draining: false });
    await releaseLegacyHostAssignmentAfterDurableTransition(
      state,
      legacySession({ assignmentConnectionId: "disconnected" }),
    );
    expect(releaseLegacyHostAssignment).toHaveBeenCalledTimes(3);
  });
});
