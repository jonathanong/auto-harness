/* eslint-disable max-lines -- message option cases share one state fixture. */
import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
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
    targetLabels: ["cmd"],
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
});
