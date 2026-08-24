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
    targetLabels: ["command"],
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
});
