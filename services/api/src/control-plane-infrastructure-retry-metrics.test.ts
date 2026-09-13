import { afterEach, describe, expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { OPERATIONAL_METRIC_ENVIRONMENT_VAR } from "./operational-metrics.ts";

const NOW = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  delete process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR];
  vi.restoreAllMocks();
});

function exhaustionCount(log: ReturnType<typeof vi.spyOn>): number {
  return log.mock.calls.filter(([line]) => String(line).includes('"InfrastructureRetryExhausted"'))
    .length;
}

function runningCheckout(): SessionRecord {
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
    infrastructureRetryCount: 1,
  };
}

function exhaustedHostLoss(): { session: SessionRecord; worktree: WorktreeRecord } {
  const session = {
    id: "terminal",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2099-01-01T00:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "wt",
    attemptId: "attempt",
    ackReceivedAt: "2026-01-01T00:00:01.000Z",
    primaryCommandStartState: "authorized",
    assignmentConnectionId: "old",
    infrastructureRetryCount: 1,
  } as SessionRecord;
  return {
    session,
    worktree: {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt",
      labels: [],
      status: "busy",
      currentSessionId: session.id,
      online: true,
    } as WorktreeRecord,
  };
}

describe("infrastructure retry exhaustion metrics", () => {
  it("emits once when two exhausted checkout status writes race", async () => {
    process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR] = "test";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let writes = 0;
    const finishSession = vi.fn(async () => (++writes === 1 ? "committed" : "duplicate"));
    const session = runningCheckout();
    const states = [0, 1].map(() => {
      const state = createControlPlaneState({ now: () => NOW });
      setDurableReadStorage(state, {
        getSession: async () => ({ ...session }),
        finishSession,
        listLogs: async () => [],
        putArchive: async () => undefined,
      });
      state.sessions.set(session.id, { ...session });
      return state;
    });
    const status = {
      type: "session:status" as const,
      sessionId: "session",
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "failed" as const,
      errorCode: "checkout_fetch_failed" as const,
    };
    const results = await Promise.all(
      states.map((state) => handleHostMessageDurable(state, status, undefined, false, false, 6)),
    );
    expect(results).toEqual([
      expect.objectContaining({ ok: true, sessionStatusAcknowledged: expect.anything() }),
      expect.objectContaining({ ok: true, sessionStatusAcknowledged: expect.anything() }),
    ]);
    expect(finishSession).toHaveBeenCalledTimes(2);
    expect(exhaustionCount(log)).toBe(1);
  });

  it("emits once when two exhausted host-loss recoveries race", async () => {
    process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR] = "test";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let writes = 0;
    const finishSession = vi.fn(async () => (++writes === 1 ? "committed" : "duplicate"));
    const { session, worktree } = exhaustedHostLoss();
    const states = [0, 1].map(() => {
      const state = createControlPlaneState({ now: () => NOW });
      state.storage = {
        listActiveSessionsByHost: async () => [session],
        getWorktree: async () => worktree,
        finishSession,
      } as never;
      return state;
    });
    await Promise.all(
      states.map((state) =>
        reconcileHostOwnedSessions(state, "host", "connection", new Set(), "lost"),
      ),
    );
    expect(finishSession).toHaveBeenCalledTimes(2);
    expect(states.map((state) => state.sessions.get(session.id)?.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(exhaustionCount(log)).toBe(1);
  });
});
