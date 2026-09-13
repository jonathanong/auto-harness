import { afterEach, describe, expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { OPERATIONAL_METRIC_ENVIRONMENT_VAR } from "./operational-metrics.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const baseSession = {
  repositoryId: "repo",
  prompt: "run",
  target: { commandId: "command" },
  fallbacks: [] as [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2099-01-01T00:00:00.000Z",
  timeout: 30,
  priority: 0,
  requiredLabels: [] as string[],
  status: "running" as const,
  queueShard: 0,
  createdAt: NOW,
  hostId: "host",
  attemptId: "attempt",
  infrastructureRetryCount: 1,
};

afterEach(() => {
  delete process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR];
  vi.restoreAllMocks();
});

function exhaustionCount(log: ReturnType<typeof vi.spyOn>): number {
  return log.mock.calls.filter(([line]) => String(line).includes('"InfrastructureRetryExhausted"'))
    .length;
}

function racingFinish() {
  let writes = 0;
  return vi.fn(async () => (++writes === 1 ? "committed" : "duplicate"));
}

async function raceReconcile(session: SessionRecord, storage: object) {
  process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR] = "test";
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const finishSession = racingFinish();
  const states = [0, 1].map(() => {
    const state = createControlPlaneState({ now: () => NOW });
    state.storage = { ...storage, finishSession } as never;
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
}

describe("infrastructure retry exhaustion metrics", () => {
  it("emits once when two exhausted checkout status writes race", async () => {
    process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR] = "test";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const finishSession = racingFinish();
    const session = { ...baseSession, id: "session", worktreeId: "worktree" } as SessionRecord;
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
    const results = await Promise.all(
      states.map((state) =>
        handleHostMessageDurable(
          state,
          {
            type: "session:status",
            sessionId: "session",
            worktreeId: "worktree",
            attemptId: "attempt",
            status: "failed",
            errorCode: "checkout_fetch_failed",
          },
          undefined,
          false,
          false,
          6,
        ),
      ),
    );
    expect(results).toEqual([
      expect.objectContaining({ ok: true, sessionStatusAcknowledged: expect.anything() }),
      expect.objectContaining({ ok: true, sessionStatusAcknowledged: expect.anything() }),
    ]);
    expect(finishSession).toHaveBeenCalledTimes(2);
    expect(exhaustionCount(log)).toBe(1);
  });

  it("emits once when two exhausted host-loss recoveries race", async () => {
    const session = {
      ...baseSession,
      id: "terminal",
      worktreeId: "wt",
      ackReceivedAt: "2026-01-01T00:00:01.000Z",
      primaryCommandStartState: "authorized",
      assignmentConnectionId: "old",
    } as SessionRecord;
    await raceReconcile(session, {
      listActiveSessionsByHost: async () => [session],
      getWorktree: async () =>
        ({
          id: "wt",
          name: "wt",
          hostId: "host",
          repositoryId: "repo",
          path: "/wt",
          labels: [],
          status: "busy",
          currentSessionId: session.id,
          online: true,
        }) as WorktreeRecord,
    });
  });

  it("emits once when two exhausted workspace host-loss recoveries race", async () => {
    const session = {
      ...baseSession,
      id: "workspace",
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      workspaceSlotLease: true,
      worktreeId: null,
      ackReceivedAt: "2026-01-01T00:00:01.000Z",
      primaryCommandStartState: "authorized",
    } as SessionRecord;
    await raceReconcile(session, {
      listActiveSessionsByHost: async () => [session],
      getWorkspaceSlot: async () => ({
        id: "slot",
        name: "slot",
        path: "/workspace/slot",
        hostId: "host",
        workspacePoolId: "pool",
        status: "busy",
        online: true,
        currentSessionId: session.id,
      }),
    });
  });
});
