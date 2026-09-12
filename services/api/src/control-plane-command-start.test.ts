import { describe, expect, it, vi } from "vitest";

import { commandStartStateForProtocol } from "./control-plane-command-start.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function runningSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    primaryCommandStartState: "pending",
    ...over,
  };
}

describe("command-start assignment gating", () => {
  it.each([undefined, 0, 2])("authorizes legacy protocol %s assignments", (version) => {
    expect(commandStartStateForProtocol(version)).toBe("authorized");
  });

  it.each([3, 4])("leaves protocol %s assignments pending", (version) => {
    expect(commandStartStateForProtocol(version)).toBe("pending");
  });

  it("acknowledges a durable command start only after its fenced commit, idempotently", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    let persisted = runningSession();
    state.sessions.set(persisted.id, persisted);
    const authorizePrimaryCommandStart = vi.fn(async () => false);
    state.storage = {
      getSession: async () => persisted,
      getHostLock: async () => "connection",
      authorizePrimaryCommandStart,
    } as never;
    const message = {
      type: "session:command-start" as const,
      sessionId: persisted.id,
      worktreeId: "worktree",
      attemptId: "attempt",
    };

    await expect(handleHostMessageDurable(state, message, "connection")).resolves.toEqual({
      ok: true,
    });
    expect(state.sessions.get(persisted.id)?.primaryCommandStartState).toBe("pending");
    expect(authorizePrimaryCommandStart).toHaveBeenCalledWith({
      sessionId: persisted.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      fence: { hostId: "host", connectionId: "connection" },
    });

    authorizePrimaryCommandStart.mockImplementationOnce(async () => {
      persisted = { ...persisted, primaryCommandStartState: "authorized" };
      return true;
    });
    await expect(handleHostMessageDurable(state, message, "connection")).resolves.toEqual({
      ok: true,
      sessionCommandStartAcknowledged: { sessionId: persisted.id, attemptId: "attempt" },
    });
    expect(state.sessions.get(persisted.id)?.primaryCommandStartState).toBe("authorized");

    await expect(handleHostMessageDurable(state, message, "connection")).resolves.toEqual({
      ok: true,
      sessionCommandStartAcknowledged: { sessionId: persisted.id, attemptId: "attempt" },
    });
    expect(authorizePrimaryCommandStart).toHaveBeenCalledTimes(2);

    await expect(
      handleHostMessageDurable(state, { ...message, attemptId: "stale" }, "connection"),
    ).resolves.toEqual({ ok: true });
    expect(authorizePrimaryCommandStart).toHaveBeenCalledTimes(2);
  });
});
