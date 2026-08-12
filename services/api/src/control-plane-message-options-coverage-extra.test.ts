import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
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
        capabilities: [],
        runningSessions: [],
      }),
    ).resolves.toMatchObject({ ok: true, connectionId: "connection" });
  });

  it("deletes an evicted fenced log chunk", async () => {
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
        stream: "stdout",
        content: "new",
        timestamp: NOW,
        seq: 10_001,
      },
      "connection",
    );
    expect(deleted).toHaveLength(1);
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
});
