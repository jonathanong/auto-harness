/* eslint-disable max-lines -- message option cases share one state fixture. */
import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import {
  appendLog,
  appendLogDurable,
  handleHostLogBatchDurable,
  handleHostMessage,
  handleHostMessageDurable,
} from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { LogRecord } from "./control-plane-types.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    hostId: "host",
    worktreeId: "w",
    attemptId: "attempt",
    ...over,
  };
}

function state(row: SessionRecord) {
  const current = createControlPlaneState({ now: () => NOW, shardCount: 1 });
  current.sessions.set(row.id, row);
  return current;
}

const status = (extra: Record<string, unknown> = {}) => ({
  type: "session:status" as const,
  sessionId: "s",
  worktreeId: null,
  attemptId: "attempt",
  status: "failed" as const,
  errorCode: "usage_limit",
  ...extra,
});

describe("host message optional-field coverage", () => {
  it("passes every optional registration snapshot through the durable facade", async () => {
    const current = createControlPlaneState({ connectionIdFactory: () => "connection" });
    await expect(
      handleHostMessageDurable(current, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        commandProfiles: [],
        repositories: [],
        capabilities: { features: [] },
        maxConcurrentAssignments: 1,
        runningSessions: [],
      }),
    ).resolves.toMatchObject({ ok: true, connectionId: "connection" });
  });

  it("evicts a fenced log chunk from memory without deleting it durably", async () => {
    const row = session();
    const current = state(row);
    const old: LogRecord[] = Array.from({ length: 10_000 }, (_, seq) => ({
      sessionId: "s",
      timestampSeq: `${NOW}#${String(seq).padStart(12, "0")}`,
      stream: "stdout",
      content: "x",
      timestamp: NOW,
      seq,
    }));
    current.logs.set("s", old);
    const committed: LogRecord[] = [];
    current.onLogCommitted = (record) => committed.push(record);
    const deleted: string[] = [];
    setDurableReadStorage(current, {
      getHostLock: async () => "connection",
      putLogFenced: async () => true,
      deleteLog: async (_id: string, key: string) => deleted.push(key),
    });
    await handleHostMessageDurable(
      current,
      {
        type: "session:log",
        sessionId: "s",
        attemptId: "attempt",
        stream: "stdout",
        content: "new",
        timestamp: NOW,
        seq: 10_001,
      },
      "connection",
    );
    expect(deleted).toEqual([]);
    // The window still slid: the oldest chunk left the cache, the newest arrived.
    expect(current.logs.get("s")).toHaveLength(10_000);
    expect(current.logs.get("s")?.at(-1)?.seq).toBe(10_001);
    expect(committed).toHaveLength(1);
  });

  it("ignores an empty retained cache entry while appending a log", () => {
    const current = state(session());
    const retained = Array.from({ length: 10_001 }, (_, seq) => ({
      sessionId: "s",
      timestampSeq: `${NOW}#${String(seq).padStart(12, "0")}`,
      stream: "stdout",
      content: "old",
      timestamp: NOW,
      seq,
    }));
    retained.shift = () => undefined;
    current.logs.set("s", retained);
    appendLog(current, {
      sessionId: "s",
      stream: "stdout",
      content: "new",
      timestamp: NOW,
      seq: 1,
    });
    expect(current.logs.get("s")?.some((record) => record.content === "new")).toBe(true);
  });

  it("returns success when a durable log batch contains only stale attempts", async () => {
    const current = state(session());
    setDurableReadStorage(current, {
      getSession: async () => session(),
      getHostLock: async () => "connection",
      putLogsFenced: async () => true,
    });
    await expect(
      handleHostLogBatchDurable(
        current,
        [
          {
            type: "session:log",
            sessionId: "s",
            attemptId: "stale",
            stream: "stdout",
            content: "old",
            timestamp: NOW,
            seq: 1,
          },
        ],
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("publishes queued and directly durable log commits", async () => {
    const current = state(session());
    const committed: LogRecord[] = [];
    current.onLogCommitted = (record) => committed.push(record);
    setDurableReadStorage(current, { putLog: async () => undefined });
    appendLog(current, {
      sessionId: "s",
      stream: "stdout",
      content: "queued",
      timestamp: NOW,
      seq: 1,
    });
    await current.writeTail;
    current.storage = undefined;
    await appendLogDurable(current, {
      sessionId: "s",
      stream: "stdout",
      content: "direct",
      timestamp: NOW,
      seq: 2,
    });
    expect(committed.map((record) => record.content)).toEqual(["queued", "direct"]);
  });

  it("stops an in-memory log batch at the first rejected chunk", async () => {
    const current = state(session());
    await expect(
      handleHostLogBatchDurable(
        current,
        [
          {
            type: "session:log",
            sessionId: "s",
            attemptId: "a",
            stream: "stdout",
            content: "x".repeat(32 * 1024 + 1),
            timestamp: NOW,
            seq: 1,
          },
        ],
        "connection",
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it("adds default providerless suppression fields without a worktree", async () => {
    const row = session({ worktreeId: null });
    const current = state(row);
    setDurableReadStorage(current, {
      getSession: async () => row,
      finishSession: async () => true,
    });
    await handleHostMessageDurable(current, status());
    expect(current.sessions.get("s")?.suppressedTargetIndexes).toEqual([0]);
  });

  it("keeps a scheduled terminal report fenced when its local lease was replaced", () => {
    const row = session({
      type: "scheduled",
      source: "schedule",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    const current = state(row);
    expect(
      handleHostMessage(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });
    expect(current.sessions.get("s")?.status).toBe("running");
  });

  it("uses the default target index for an in-memory providerless retry", () => {
    const current = state(session());
    handleHostMessage(current, {
      type: "session:status",
      sessionId: "s",
      worktreeId: "w",
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(current.sessions.get("s")?.suppressedTargetIndexes).toEqual([0]);
  });

  it("treats an uncached provider account as absent for local usage-limit planning", () => {
    const current = state(
      session({
        resolvedRoute: {
          targetIndex: 0,
          commandId: "cmd",
          providerAccountId: "account",
          hostId: "host",
          worktreeId: "w",
          attemptId: "attempt",
        },
      }),
    );
    expect(
      handleHostMessage(current, {
        ...status(),
        worktreeId: "w",
      }),
    ).toEqual({ ok: true });
  });

  it("routes standalone and terminal usage reports through both message facades", async () => {
    const usage = {
      kind: "delta" as const,
      sequence: 1,
      inputTokens: "2",
      source: "cli" as const,
      observedAt: NOW,
    };
    const current = state(session());
    expect(
      handleHostMessage(current, {
        type: "session:usage",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        usage,
      }),
    ).toEqual({ ok: true });
    expect(
      handleHostMessage(current, {
        ...status({ usage: { unsupported: true } }),
      } as never),
    ).toMatchObject({ ok: false });

    const durable = state(session());
    setDurableReadStorage(durable, { getSession: async () => session() });
    await expect(
      handleHostMessageDurable(durable, {
        type: "session:usage",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        usage: {} as never,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      handleHostMessageDurable(durable, status({ usage: { unsupported: true } }) as never),
    ).resolves.toMatchObject({ ok: false });

    const fenced = state(session());
    setDurableReadStorage(fenced, {
      getSession: async () => session(),
      getHostLock: async () => "connection",
    });
    await expect(
      handleHostMessageDurable(
        fenced,
        status({ worktreeId: "w", usage: { unsupported: true } }) as never,
        "connection",
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it("passes draining registration snapshots and rejects unsupported in-memory messages", async () => {
    const current = createControlPlaneState({ connectionIdFactory: () => "connection" });
    expect(
      handleHostMessage(current, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        commandProfiles: [],
        draining: true,
      }),
    ).toEqual({ ok: true });
    expect(handleHostMessage(current, { type: "unsupported" } as never)).toMatchObject({
      ok: false,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "host:register",
        hostId: "durable-host",
        worktrees: [],
        commandProfiles: [],
        draining: true,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("accepts array capability advertisements and acks a session with no host", () => {
    const current = createControlPlaneState({ connectionIdFactory: () => "connection" });
    expect(
      handleHostMessage(current, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        capabilities: ["scheduled-main-checkout"],
      }),
    ).toEqual({ ok: true });
    expect(current.connections.get("connection")?.capabilities).toEqual([
      "scheduled-main-checkout",
    ]);

    const orphan = state(session({ hostId: null }));
    expect(
      handleHostMessage(orphan, {
        type: "session:ack",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
      }),
    ).toEqual({ ok: true });
    expect(orphan.sessions.get("s")?.ackReceivedAt).toBe(NOW);
  });

  it("rejects a durable log batch whose session disappeared", async () => {
    const current = state(session());
    setDurableReadStorage(current, {
      getSession: async () => null,
      getHostLock: async () => "connection",
    });
    await expect(
      handleHostLogBatchDurable(
        current,
        [
          {
            type: "session:log",
            sessionId: "s",
            attemptId: "attempt",
            stream: "stdout",
            content: "gone",
            timestamp: NOW,
            seq: 1,
          },
        ],
        "connection",
      ),
    ).resolves.toEqual({ ok: false, error: "stale host connection" });
  });

  it("requeues omitted in-memory sessions on a keepalive that lists running sessions", async () => {
    const current = createControlPlaneState({
      now: () => NOW,
      connectionIdFactory: () => "connection",
    });
    expect(
      handleHostMessage(current, {
        type: "host:register",
        hostId: "host",
        worktrees: [{ id: "w", name: "w", repositoryId: "repo", path: "/repo/w", labels: [] }],
      }),
    ).toEqual({ ok: true });
    const row = session({ ackReceivedAt: NOW });
    current.sessions.set(row.id, row);
    current.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo/w",
      labels: [],
      status: "busy",
      currentSessionId: "s",
      online: true,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
        runningSessions: [],
      }),
    ).resolves.toEqual({ ok: true });
    expect(current.sessions.get("s")?.status).toBe("queued");
  });

  it("does not requeue on a keepalive that still reports the running session", async () => {
    const current = createControlPlaneState({
      now: () => NOW,
      connectionIdFactory: () => "connection",
    });
    expect(
      handleHostMessage(current, {
        type: "host:register",
        hostId: "host",
        worktrees: [{ id: "w", name: "w", repositoryId: "repo", path: "/repo/w", labels: [] }],
      }),
    ).toEqual({ ok: true });
    const row = session({ ackReceivedAt: NOW });
    current.sessions.set(row.id, row);
    current.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo/w",
      labels: [],
      status: "busy",
      currentSessionId: "s",
      online: true,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
        runningSessions: ["s"],
      }),
    ).resolves.toEqual({ ok: true });
    expect(current.sessions.get("s")?.status).toBe("running");
  });

  it("retries archive then ignores a durable terminal report for an already-finished session", async () => {
    const row = session({ status: "completed", completedAt: NOW });
    const current = state(row);
    setDurableReadStorage(current, {
      getSession: async () => row,
      putArchive: async () => undefined,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "completed",
      }),
    ).resolves.toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "s", attemptId: "attempt" },
    });
    expect(current.sessions.get("s")?.status).toBe("completed");
  });

  it("does not idle a cancelled worktree that another session now owns", async () => {
    const row = session({ status: "cancelled" });
    const current = state(row);
    current.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "host",
      repositoryId: "repo",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "other",
    });
    setDurableReadStorage(current, {
      getSession: async () => row,
      releaseCancelledSessionWorktree: async () => true,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "completed",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(current.worktrees.get("w")?.currentSessionId).toBe("other");
    expect(current.sessions.get("s")?.worktreeId).toBeNull();
  });

  it("keeps a cancelled durable session parked when worktree release loses", async () => {
    const row = session({ status: "cancelled" });
    const current = state(row);
    setDurableReadStorage(current, {
      getSession: async () => row,
      releaseCancelledSessionWorktree: async () => false,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "completed",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(current.sessions.get("s")?.status).toBe("cancelled");
  });

  it("forwards a host assignment lease when a missing-account scheduled run requeues", async () => {
    const row = session({
      type: "scheduled",
      source: "schedule",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
      hostAssignmentLease: { hostId: "host" },
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "account",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
      },
    });
    const current = state(row);
    let released: Record<string, unknown> | undefined;
    setDurableReadStorage(current, {
      getSession: async () => current.sessions.get("s") ?? row,
      getProviderAccount: async () => null,
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        released = input;
        return true;
      },
      listConnections: async () => [],
      listHostInventories: async () => [],
    });
    await expect(handleHostMessageDurable(current, status())).resolves.toMatchObject({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "s", attemptId: "attempt" },
    });
    expect(released).toMatchObject({
      status: "queued",
      hostAssignmentLease: { hostId: "host" },
    });
    expect(current.sessions.get("s")).toMatchObject({
      status: "queued",
      errorCode: "usage_limit",
    });
  });

  it("records a provider cooldown on the loaded account after a worktree usage-limit retry", async () => {
    const account = {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 60,
      maxConcurrentSessions: 1,
    };
    const row = session({
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "account",
        hostId: "host",
        worktreeId: "w",
        attemptId: "attempt",
      },
    });
    const current = state(row);
    current.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "host",
      repositoryId: "repo",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "s",
    });
    setDurableReadStorage(current, {
      getSession: async () => row,
      getProviderAccount: async () => account,
      requeueUsageLimitedSession: async () => true,
      listConnections: async () => [],
      listHostInventories: async () => [],
    });
    await expect(
      handleHostMessageDurable(current, { ...status(), worktreeId: "w" }),
    ).resolves.toMatchObject({ ok: true });
    expect(current.providerAccounts.get("account")?.usageLimitedUntil).toBeTruthy();
    expect(current.sessions.get("s")?.status).toBe("queued");
  });

  it("releases a cancelled local main-checkout lease from a late terminal report", () => {
    const current = state(
      session({
        status: "cancelled",
        type: "scheduled",
        source: "schedule",
        worktreeId: null,
        mainCheckoutLease: true,
        assignmentConnectionId: "connection",
      }),
    );
    expect(
      handleHostMessage(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
        result: { summary: "late scheduled", summarySource: "harness" },
      }),
    ).toEqual({ ok: true });
    expect(current.sessions.get("s")).not.toHaveProperty("mainCheckoutLease");
    expect(current.sessions.get("s")?.result).toEqual({
      summary: "late scheduled",
      summarySource: "harness",
    });
  });

  it("clears a cancelled local worktree that another session now owns", () => {
    const current = state(session({ status: "cancelled" }));
    current.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "host",
      repositoryId: "repo",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "other",
    });
    expect(
      handleHostMessage(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "completed",
        result: { summary: "late worktree", summarySource: "agent" },
      }),
    ).toEqual({ ok: true });
    expect(current.sessions.get("s")?.worktreeId).toBeNull();
    expect(current.sessions.get("s")?.result).toEqual({
      summary: "late worktree",
      summarySource: "agent",
    });
    expect(current.worktrees.get("w")?.currentSessionId).toBe("other");
  });

  it("applies a local usage-limit cooldown to a cached provider account", () => {
    const current = state(
      session({
        resolvedRoute: {
          targetIndex: 0,
          commandId: "cmd",
          providerAccountId: "account",
          hostId: "host",
          worktreeId: "w",
          attemptId: "attempt",
        },
      }),
    );
    current.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 60,
      maxConcurrentSessions: 1,
    });
    expect(handleHostMessage(current, { ...status(), worktreeId: "w" })).toEqual({ ok: true });
    expect(current.providerAccounts.get("account")?.usageLimitedUntil).toBeTruthy();
    expect(current.sessions.get("s")?.status).toBe("queued");
  });

  it("applies a valid usage report before a durable terminal status", async () => {
    const usage = {
      kind: "delta" as const,
      sequence: 1,
      inputTokens: "2",
      source: "cli" as const,
      observedAt: NOW,
    };
    const current = state(session());
    current.hostConnection.set("host", "connection");
    current.connections.set("connection", {
      connectionId: "connection",
      type: "host",
      hostId: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
    });
    setDurableReadStorage(current, {
      getSession: async () => current.sessions.get("s"),
      getHostLock: async () => "connection",
      listUsageRecords: async () => [],
      putUsageRecord: async () => true,
      finishSession: async () => true,
      putArchive: async () => undefined,
    });
    await expect(
      handleHostMessageDurable(
        current,
        {
          type: "session:status",
          sessionId: "s",
          worktreeId: "w",
          attemptId: "attempt",
          status: "completed",
          usage,
        },
        "connection",
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(current.sessions.get("s")?.status).toBe("completed");
  });

  it("releases a cancelled durable worktree even when the row is already gone from memory", async () => {
    const row = session({ status: "cancelled" });
    const current = state(row);
    setDurableReadStorage(current, {
      getSession: async () => row,
      releaseCancelledSessionWorktree: async () => true,
    });
    await expect(
      handleHostMessageDurable(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "completed",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(current.sessions.get("s")?.worktreeId).toBeNull();
  });

  it("requeues a missing-account scheduled run without a host assignment lease", async () => {
    const row = session({
      type: "scheduled",
      source: "schedule",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "account",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
      },
    });
    const current = state(row);
    let released: Record<string, unknown> | undefined;
    setDurableReadStorage(current, {
      getSession: async () => current.sessions.get("s") ?? row,
      getProviderAccount: async () => null,
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        released = input;
        return true;
      },
      listConnections: async () => [],
      listHostInventories: async () => [],
    });
    await expect(handleHostMessageDurable(current, status())).resolves.toMatchObject({ ok: true });
    expect(released).not.toHaveProperty("hostAssignmentLease");
  });

  it("requeues a usage-limited worktree even when the live worktree row is missing", async () => {
    const account = {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 60,
      maxConcurrentSessions: 1,
    };
    const row = session({
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "account",
        hostId: "host",
        worktreeId: "w",
        attemptId: "attempt",
      },
    });
    const current = state(row);
    setDurableReadStorage(current, {
      getSession: async () => current.sessions.get("s") ?? row,
      getProviderAccount: async () => account,
      requeueUsageLimitedSession: async () => true,
      listConnections: async () => [],
      listHostInventories: async () => [],
    });
    await expect(
      handleHostMessageDurable(current, { ...status(), worktreeId: "w" }),
    ).resolves.toMatchObject({ ok: true });
    expect(current.sessions.get("s")?.status).toBe("queued");
  });

  it("ignores a late local terminal report with nothing left to release", () => {
    const current = state(session({ status: "cancelled", worktreeId: null }));
    expect(
      handleHostMessage(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });
  });

  it("finishes a local worktree attempt without clearing an existing resume ref", () => {
    const current = state(session({ cliResumeRef: "keep" }));
    expect(
      handleHostMessage(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "completed",
        cliResumeRef: "keep",
        result: { summary: "local result", summarySource: "agent" },
      }),
    ).toEqual({ ok: true });
    expect(current.sessions.get("s")).toMatchObject({
      status: "completed",
      worktreeId: null,
      cliResumeRef: "keep",
      result: { summary: "local result", summarySource: "agent" },
    });
  });

  it("clears a continuation reference when a resumed local attempt finishes without a new one", () => {
    const current = state(session({ resumedFromSessionId: "parent", cliResumeRef: "old" }));
    expect(
      handleHostMessage(current, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });
    expect(current.sessions.get("s")).toMatchObject({ status: "completed", worktreeId: null });
    expect(current.sessions.get("s")).not.toHaveProperty("cliResumeRef");
  });
});
