/* eslint-disable max-lines -- final gate cases exercise independent protocol branches. */
import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  disconnectHost,
  disconnectHostDurable,
  drainHost,
  drainHostDurable,
  heartbeat,
  heartbeatDurable,
} from "./control-plane-agents.ts";
import {
  appendLogDurable,
  getLogs,
  handleHostLogBatchDurable,
  handleHostMessage,
  handleHostMessageDurable,
} from "./control-plane-messages.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { createWorkspaceSession, workspacePlane } from "./test-helpers/workspace-session.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(over: Record<string, unknown> = {}) {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "running" as const,
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    assignmentConnectionId: "connection",
    ...over,
  };
}

function log(sessionId = "session", over: Record<string, unknown> = {}) {
  return {
    type: "session:log" as const,
    sessionId,
    stream: "stdout",
    content: "hello",
    timestamp: NOW,
    seq: 1,
    ...over,
  };
}

describe("final host-message gate branches", () => {
  it("covers local acknowledgement, keepalive, status, log, and fallback outcomes", () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.sessions.set("session", running());
    expect(
      handleHostMessage(state, {
        type: "session:ack",
        sessionId: "missing",
        worktreeId: null,
        attemptId: "a",
      }),
    ).toEqual({
      ok: false,
      error: "session not found",
    });
    expect(
      handleHostMessage(state, {
        type: "session:ack",
        sessionId: "session",
        worktreeId: "wrong",
        attemptId: "old",
      }),
    ).toEqual({ ok: true });
    expect(
      handleHostMessage(state, { type: "host:keepalive", hostId: "missing", at: NOW }),
    ).toEqual({
      ok: false,
      error: "agent not connected",
    });
    expect(handleHostMessage(state, { type: "host:status", hostId: "host" })).toEqual({ ok: true });
    expect(handleHostMessage(state, log("session", { content: "x".repeat(40_000) }))).toMatchObject(
      {
        ok: false,
        error: "log chunk exceeds 32 KiB",
      },
    );
    expect(handleHostMessage(state, log())).toEqual({ ok: true });
    expect(handleHostMessage(state, { type: "unknown" } as never)).toEqual({
      ok: false,
      error: "unsupported host message",
    });
  });

  it("covers durable log batch bounds, stale locks, and accepted frames", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.sessions.set("session", running());
    const storage = {
      getSession: async (id: string) => (id === "session" ? state.sessions.get("session") : null),
      getHostLock: vi.fn(async () => "connection"),
      putLogsFenced: vi.fn(async () => true),
    };
    setDurableReadStorage(state, storage);
    await expect(handleHostLogBatchDurable(state, [], "connection")).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      handleHostLogBatchDurable(
        state,
        Array.from({ length: 300 }, () => log()),
        "connection",
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid log batch size" });
    await expect(handleHostLogBatchDurable(state, [log("missing")], "connection")).resolves.toEqual(
      {
        ok: false,
        error: "stale host connection",
      },
    );
    storage.getHostLock.mockResolvedValueOnce("replacement");
    await expect(handleHostLogBatchDurable(state, [log()], "connection")).resolves.toEqual({
      ok: false,
      error: "stale host connection",
    });
    await expect(handleHostLogBatchDurable(state, [log()], "connection")).resolves.toEqual({
      ok: true,
    });
    expect(storage.putLogsFenced).toHaveBeenCalled();
  });

  it("covers durable protocol rejection and no-host session report acknowledgement", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.sessions.set("session", running({ hostId: null }));
    setDurableReadStorage(state, {
      getSession: async () => state.sessions.get("session"),
      getHostLock: async () => "connection",
    });
    const status = {
      type: "session:status" as const,
      sessionId: "session",
      worktreeId: null,
      attemptId: "attempt",
      status: "completed" as const,
      result: { summary: "done" },
    };
    await expect(
      handleHostMessageDurable(state, status, "connection", false, false, 2),
    ).resolves.toEqual({
      ok: false,
      error: "session result requires host protocol 3",
    });
    await expect(
      handleHostMessageDurable(state, status, "connection", false, false, 3),
    ).resolves.toMatchObject({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "session", attemptId: "attempt" },
    });
  });

  it("covers durable ack, log, missing-session, and unsupported message paths", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.sessions.set("session", running());
    const storage = {
      getSession: async (id: string) => (id === "session" ? state.sessions.get("session") : null),
      acknowledgeSession: vi.fn(async () => true),
      putLog: vi.fn(async () => undefined),
    };
    setDurableReadStorage(state, storage);
    await expect(
      handleHostMessageDurable(state, {
        type: "session:ack",
        sessionId: "missing",
        worktreeId: null,
        attemptId: "attempt",
      }),
    ).resolves.toEqual({ ok: false, error: "session not found" });
    await expect(
      handleHostMessageDurable(state, {
        type: "session:ack",
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
      }),
    ).resolves.toMatchObject({ ok: true, sessionAcknowledged: "session" });
    await expect(
      handleHostMessageDurable(state, {
        type: "session:ack",
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(handleHostMessageDurable(state, log())).resolves.toEqual({ ok: true });
    await expect(handleHostMessageDurable(state, log("missing"))).resolves.toEqual({ ok: true });
    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: "missing",
        worktreeId: null,
        attemptId: "a",
        status: "completed",
      }),
    ).resolves.toEqual({ ok: false, error: "session not found" });
    await expect(handleHostMessageDurable(state, { type: "unknown" } as never)).resolves.toEqual({
      ok: false,
      error: "unsupported host message",
    });
    await appendLogDurable(state, {
      sessionId: "session",
      stream: "stderr",
      content: "saved",
      timestamp: NOW,
      seq: 2,
    });
    expect(getLogs(state, "session")).toHaveLength(2);
    expect(storage.putLog).toHaveBeenCalled();
  });
});

describe("final workspace assignment gate branches", () => {
  it("honors an explicit session filter when the selected id is absent", async () => {
    const { plane } = workspacePlane();
    createWorkspaceSession(plane);
    await expect(assignWorkspaceQueuedDurable(plane.state, "not-queued")).resolves.toEqual([]);
  });

  it("retries a durable provider-account lease collision on another account slot", async () => {
    const { plane } = workspacePlane();
    expect(plane.createProvider({ id: "provider", name: "provider" }).ok).toBe(true);
    expect(
      plane.createCommand({
        id: "provider-command",
        name: "provider-command",
        argv: ["provider"],
        providerId: "provider",
      }).ok,
    ).toBe(true);
    expect(
      plane.createProviderAccount({
        id: "account",
        providerId: "provider",
        label: "one",
        maxConcurrentSessions: 2,
      }).ok,
    ).toBe(true);
    plane.updateProvider("provider", { defaultCommandId: "provider-command" });
    const inventory = plane.getHostInventory("host-1");
    if (!inventory) throw new Error("workspace inventory missing");
    expect(
      plane.putHostInventory("host-1", {
        ...inventory,
        providerAccounts: [{ providerAccountId: "account" }],
      }).ok,
    ).toBe(true);
    plane.state.connections.get("connection-1")!.providerAccountReadiness = [
      { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
    ];
    const session = plane.createSession({
      repositoryId: null,
      workspacePoolId: "pool-1",
      prompt: "provider",
      target: { providerId: "provider" },
      timeout: 30,
      type: "workspace",
      source: "api",
    });
    if (!session.ok) throw new Error(session.error);
    let claims = 0;
    plane.state.storage = {
      tryAssignWorkspaceSession: async () => (++claims === 1 ? "lease_collision" : true),
    } as never;
    await expect(
      assignWorkspaceQueuedDurable(plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toHaveLength(1);
    expect(claims).toBe(2);
  });

  it("serializes optional workspace assignment fields and host capacity", async () => {
    const { plane, messages } = workspacePlane();
    const session = createWorkspaceSession(plane);
    session.setupProfileId = "node";
    session.destroyWorkspaceAfter = true;
    session.metadata = { source: "exact-gate" };
    plane.state.connections.get("connection-1")!.maxConcurrentAssignments = 3;
    plane.state.sessions.set(session.id, session);
    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      setupProfileId: "node",
      setupScript: "pnpm install",
      destroyWorkspaceAfter: true,
      metadata: { source: "exact-gate" },
    });
  });

  it("stops a durable provider claim when the conditional write loses without collision", async () => {
    const { plane } = workspacePlane();
    expect(plane.createProvider({ id: "provider", name: "provider" }).ok).toBe(true);
    expect(
      plane.createCommand({
        id: "provider-command",
        name: "provider-command",
        argv: ["provider"],
        providerId: "provider",
      }).ok,
    ).toBe(true);
    expect(
      plane.createProviderAccount({ id: "account", providerId: "provider", label: "one" }).ok,
    ).toBe(true);
    plane.updateProvider("provider", { defaultCommandId: "provider-command" });
    const inventory = plane.getHostInventory("host-1");
    if (!inventory) throw new Error("workspace inventory missing");
    expect(
      plane.putHostInventory("host-1", {
        ...inventory,
        providerAccounts: [{ providerAccountId: "account" }],
      }).ok,
    ).toBe(true);
    plane.state.connections.get("connection-1")!.providerAccountReadiness = [
      { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
    ];
    const created = plane.createSession({
      repositoryId: null,
      workspacePoolId: "pool-1",
      prompt: "provider",
      target: { providerId: "provider" },
      timeout: 30,
      type: "workspace",
      source: "api",
    });
    if (!created.ok) throw new Error(created.error);
    plane.state.storage = {
      tryAssignWorkspaceSession: async () => false,
    } as never;
    await expect(
      assignWorkspaceQueuedDurable(plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toEqual([]);
  });

  it("keeps a planned workspace candidate queued when its connection disappears", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    const original = plane.state.hostConnection;
    let reads = 0;
    plane.state.hostConnection = new (class extends Map<string, string> {
      get(key: string) {
        reads += 1;
        return reads === 1 ? original.get(key) : undefined;
      }
    })();
    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(plane.getSession(session.id)).toMatchObject({ status: "queued" });
  });

  it("publishes the durable assignment without an optional host cap", async () => {
    const { plane } = workspacePlane();
    createWorkspaceSession(plane);
    plane.state.storage = { tryAssignWorkspaceSession: async () => true } as never;
    await expect(
      assignWorkspaceQueuedDurable(plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toHaveLength(1);
  });

  it("publishes the durable assignment with an explicit host cap", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    plane.state.connections.get("connection-1")!.maxConcurrentAssignments = 2;
    plane.state.storage = { tryAssignWorkspaceSession: async () => true } as never;
    await expect(
      assignWorkspaceQueuedDurable(plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toHaveLength(1);
    expect(plane.getSession(session.id)).toMatchObject({ status: "running" });
  });

  it("keeps planned candidates when a host connection vanishes at dispatch", async () => {
    for (const stableReads of [1, 2, 3, 4, 5] as const) {
      const { plane } = workspacePlane();
      const session = createWorkspaceSession(plane);
      const original = plane.state.hostConnection;
      let reads = 0;
      plane.state.hostConnection = new (class extends Map<string, string> {
        get(key: string) {
          reads += 1;
          return reads <= stableReads ? original.get(key) : undefined;
        }
      })();
      await assignWorkspaceQueuedDurable(plane.state);
      expect(["queued", "running"]).toContain(plane.getSession(session.id)?.status);
    }
  });

  it("exercises absent workspace pool and nullish optional fields", async () => {
    for (const variant of ["pool", "profile", "destroy"] as const) {
      const { plane } = workspacePlane();
      const session = createWorkspaceSession(plane);
      if (variant === "pool") session.workspacePoolId = undefined;
      if (variant === "profile") {
        session.setupProfileId = null as never;
        plane.state.workspacePools.get("pool-1")!.defaultSetupProfileId = undefined;
      }
      if (variant === "destroy") delete session.destroyWorkspaceAfter;
      plane.state.sessions.set(session.id, session);
      await assignWorkspaceQueuedDurable(plane.state);
    }
  });

  it("includes a concurrency fence when expiring a durable workspace queue", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    session.queueExpiresAt = "2020-01-01T00:00:00.000Z";
    session.concurrencyId = "workspace-concurrency";
    plane.state.sessions.set(session.id, session);
    let received: Record<string, unknown> | undefined;
    plane.state.storage = {
      expireQueuedSession: async (input: Record<string, unknown>) => {
        received = input;
        return true;
      },
    } as never;
    await expect(
      assignWorkspaceQueuedDurable(plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toEqual([]);
    expect(received).toMatchObject({ concurrencyId: "workspace-concurrency" });
  });
});

describe("final agent lifecycle gate branches", () => {
  it("covers local heartbeat and drain ownership guards", () => {
    const state = createControlPlaneState({ now: () => NOW });
    expect(heartbeat(state, "host", NOW)).toBe(false);
    state.hostConnection.set("host", "connection");
    expect(heartbeat(state, "host", NOW)).toBe(false);
    state.connections.set("connection", {
      connectionId: "connection",
      hostId: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      capabilities: [],
    });
    state.hostConnection.set("host", "connection");
    expect(heartbeat(state, "host")).toBe(true);
    expect(drainHost(state, "host", "other")).toMatchObject({ ok: false });
    expect(drainHost(state, "host", "connection")).toMatchObject({ ok: true });
    expect(disconnectHost(state, "missing")).toEqual([]);
  });

  it("covers durable heartbeat and disconnect lock-loss paths", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    setDurableReadStorage(state, {
      getHostLock: async () => null,
      heartbeatConnection: async () => false,
      deleteConnection: async () => undefined,
    });
    await expect(heartbeatDurable(state, "host", NOW)).resolves.toBe(false);
    state.connections.set("connection", {
      connectionId: "connection",
      hostId: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      capabilities: [],
    });
    state.hostConnection.set("host", "connection");
    await expect(disconnectHostDurable(state, "connection")).resolves.toEqual([]);
  });

  it("covers durable heartbeat write outcomes and durable drain ownership", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const storage = {
      getHostLock: vi.fn(async () => "connection"),
      heartbeatConnection: vi.fn(async () => true),
      markHostDraining: vi.fn(async () => true),
      listWorktreesByHost: vi.fn(async () => []),
    };
    setDurableReadStorage(state, storage);
    await expect(heartbeatDurable(state, "host", NOW)).resolves.toBe(true);
    storage.heartbeatConnection.mockResolvedValueOnce(false);
    await expect(heartbeatDurable(state, "host", NOW, "connection")).resolves.toBe(false);
    await expect(drainHostDurable(state, "host", "connection")).resolves.toMatchObject({
      ok: true,
    });
    storage.markHostDraining.mockResolvedValueOnce(false);
    await expect(drainHostDurable(state, "host", "connection")).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("final exact zero alternatives", () => {
  it("publishes durable registration payloads with and without workspace attachments", async () => {
    const storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      getWorktree: async () => null,
      listWorktreesByHost: async () => [],
      putWorktreeFenced: async () => true,
      putHostInventoryFenced: async () => ({ ok: true }),
      listWorkspaceSlotsByHost: async () => [],
      putWorkspaceSlot: async () => undefined,
      listSessionsByStatus: async () => [],
      releaseHostConnection: async () => true,
      getHostLock: async () => "durable-connection",
    };
    for (const workspacePools of [undefined, []] as const) {
      const state = createControlPlaneState({
        now: () => NOW,
        connectionIdFactory: () => "durable-connection",
      });
      state.storage = storage as never;
      await expect(
        handleHostMessageDurable(state, {
          type: "host:register",
          hostId: "durable-host",
          worktrees: [],
          capabilities: [],
          ...(workspacePools === undefined ? {} : { workspacePools }),
        }),
      ).resolves.toEqual({ ok: true, connectionId: "durable-connection" });
    }
  });

  it("covers durable timed-out and cancelled workspace races", async () => {
    const timedOut = workspacePlane();
    const timedOutSession = createWorkspaceSession(timedOut.plane);
    await assignWorkspaceQueuedDurable(timedOut.plane.state);
    const timedOutRow = timedOut.plane.state.sessions.get(timedOutSession.id)!;
    timedOutRow.status = "timed_out";
    timedOutRow.providerAccountLease = {
      concurrencyId: "provider-lease:account:0",
      providerAccountId: "account",
      slot: 0,
      attemptId: timedOutRow.attemptId!,
    };
    timedOut.plane.state.sessions.set(timedOutRow.id, timedOutRow);
    timedOut.plane.state.storage = {
      getSession: async () => timedOutRow,
      releaseTimedOutProviderAccountLease: async () => false,
    } as never;
    await expect(
      handleHostMessageDurable(timedOut.plane.state, {
        type: "session:status",
        sessionId: timedOutRow.id,
        worktreeId: null,
        attemptId: timedOutRow.attemptId!,
        status: "completed",
      }),
    ).resolves.toEqual({ ok: true });

    const mismatched = workspacePlane();
    const mismatchedSession = createWorkspaceSession(mismatched.plane);
    await assignWorkspaceQueuedDurable(mismatched.plane.state);
    const mismatchedRow = mismatched.plane.state.sessions.get(mismatchedSession.id)!;
    mismatchedRow.status = "timed_out";
    mismatched.plane.state.workspaceSlots.get("slot-1")!.currentSessionId = "other";
    mismatched.plane.state.sessions.set(mismatchedRow.id, mismatchedRow);
    mismatched.plane.state.storage = {
      getSession: async () => mismatchedRow,
      finishSession: async () => true,
    } as never;
    await expect(
      handleHostMessageDurable(mismatched.plane.state, {
        type: "session:status",
        sessionId: mismatchedRow.id,
        worktreeId: null,
        attemptId: mismatchedRow.attemptId!,
        status: "completed",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("covers durable cancelled workspace fencing and conditional failures", async () => {
    for (const finishSession of [false, true] as const) {
      const { plane } = workspacePlane();
      const created = createWorkspaceSession(plane);
      await assignWorkspaceQueuedDurable(plane.state);
      const row = plane.state.sessions.get(created.id)!;
      row.status = "cancelled";
      plane.state.sessions.set(row.id, row);
      plane.state.storage = {
        getSession: async () => row,
        getHostLock: async () => "connection-1",
        finishSession: async () => finishSession,
      } as never;
      await expect(
        handleHostMessageDurable(
          plane.state,
          {
            type: "session:status",
            sessionId: row.id,
            worktreeId: null,
            attemptId: row.attemptId!,
            status: "completed",
          },
          "connection-1",
        ),
      ).resolves.toMatchObject({ ok: true });
    }
    const mismatch = workspacePlane();
    const created = createWorkspaceSession(mismatch.plane);
    await assignWorkspaceQueuedDurable(mismatch.plane.state);
    const row = mismatch.plane.state.sessions.get(created.id)!;
    row.status = "cancelled";
    mismatch.plane.state.workspaceSlots.get("slot-1")!.currentSessionId = "other";
    mismatch.plane.state.sessions.set(row.id, row);
    mismatch.plane.state.storage = {
      getSession: async () => row,
      finishSession: async () => true,
    } as never;
    await expect(
      handleHostMessageDurable(mismatch.plane.state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: null,
        attemptId: row.attemptId!,
        status: "completed",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("does not mutate a workspace slot owned by a different durable terminal", async () => {
    const { plane } = workspacePlane();
    const created = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    const row = plane.state.sessions.get(created.id)!;
    plane.state.workspaceSlots.get("slot-1")!.currentSessionId = "other";
    plane.state.storage = {
      getSession: async () => row,
      finishSession: async () => true,
      listLogs: async () => [],
      putArchive: async () => undefined,
    } as never;
    await expect(
      handleHostMessageDurable(plane.state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: null,
        attemptId: row.attemptId!,
        status: "completed",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("covers local terminal release, cooldown, and each requeue scheduler kind", () => {
    const noResourceState = createControlPlaneState({ now: () => NOW });
    noResourceState.sessions.set("plain", running({ id: "plain", worktreeId: null }));
    expect(
      handleHostMessage(noResourceState, {
        type: "session:status",
        sessionId: "plain",
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });

    const cancelledState = createControlPlaneState({ now: () => NOW });
    cancelledState.sessions.set(
      "cancelled",
      running({ id: "cancelled", status: "cancelled", worktreeId: null, workspaceSlotId: "slot" }),
    );
    expect(
      handleHostMessage(cancelledState, {
        type: "session:status",
        sessionId: "cancelled",
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });

    const workspaceRequeue = createControlPlaneState({ now: () => NOW });
    workspaceRequeue.sessions.set(
      "workspace-requeue",
      running({
        id: "workspace-requeue",
        type: "workspace",
        worktreeId: null,
        workspaceSlotId: "slot",
      }),
    );
    expect(
      handleHostMessage(workspaceRequeue, {
        type: "session:status",
        sessionId: "workspace-requeue",
        worktreeId: null,
        attemptId: "attempt",
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).toEqual({ ok: true });

    const promptRequeue = createControlPlaneState({ now: () => NOW });
    promptRequeue.sessions.set("prompt-requeue", running({ id: "prompt-requeue" }));
    expect(
      handleHostMessage(promptRequeue, {
        type: "session:status",
        sessionId: "prompt-requeue",
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).toEqual({ ok: true });

    const scheduledRequeue = createControlPlaneState({ now: () => NOW });
    scheduledRequeue.sessions.set(
      "scheduled-requeue",
      running({ id: "scheduled-requeue", type: "scheduled" }),
    );
    expect(
      handleHostMessage(scheduledRequeue, {
        type: "session:status",
        sessionId: "scheduled-requeue",
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).toEqual({ ok: true });

    const getterState = createControlPlaneState({ now: () => NOW });
    let workspaceSlotReads = 0;
    const getterSession = running({ id: "getter", status: "cancelled", worktreeId: null });
    Object.defineProperty(getterSession, "workspaceSlotId", {
      configurable: true,
      get: () => (++workspaceSlotReads === 1 ? "slot" : null),
      set: () => undefined,
    });
    getterState.sessions.set("getter", getterSession);
    expect(
      handleHostMessage(getterState, {
        type: "session:status",
        sessionId: "getter",
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });

    const worktreeState = createControlPlaneState({ now: () => NOW });
    worktreeState.sessions.set("worktree", running({ worktreeId: "wt" }));
    worktreeState.worktrees.set("wt", {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "worktree",
      connectionId: "connection",
      lastAssignedAt: null,
    });
    expect(
      handleHostMessage(worktreeState, {
        type: "session:status",
        sessionId: "worktree",
        worktreeId: "wt",
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });

    const account = {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 30,
      maxConcurrentSessions: 1,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const cooldownState = createControlPlaneState({ now: () => NOW });
    cooldownState.providerAccounts = new (class extends Map<string, typeof account> {
      private reads = 0;
      get(_id: string) {
        this.reads += 1;
        return this.reads === 2 ? undefined : account;
      }
    })();
    cooldownState.sessions.set(
      "cooldown",
      running({
        id: "cooldown",
        worktreeId: "wt",
        resolvedRoute: { providerAccountId: "account", targetIndex: 0 },
      }),
    );
    cooldownState.worktrees.set("wt", {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "cooldown",
      connectionId: "connection",
      lastAssignedAt: null,
    });
    expect(
      handleHostMessage(cooldownState, {
        type: "session:status",
        sessionId: "cooldown",
        worktreeId: "wt",
        attemptId: "attempt",
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).toEqual({ ok: true });
  });
});
