import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
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
    assignmentSentAt: NOW,
    ackReceivedAt: NOW,
    mainCheckoutLease: true,
    worktreeId: null,
    attemptId: "attempt",
    ...over,
  };
}

function storage(over: Record<string, unknown> = {}) {
  return {
    releaseMainCheckoutSession: async () => true,
    finishSession: async () => true,
    releaseCancelledSessionWorktree: async () => true,
    listLogs: async () => [],
    putArchive: async () => undefined,
    ...over,
  };
}

function durable(row: SessionRecord, methods: Record<string, unknown> = {}) {
  const state = createControlPlaneState({ now: () => NOW, usageLimitRetryCeiling: 1 });
  state.storage = storage(methods) as never;
  state.sessions.set(row.id, row);
  return state;
}

const status = (
  sessionId: string,
  value: "completed" | "failed" | "cancelled" | "timed_out",
  extra = {},
) => ({
  type: "session:status" as const,
  sessionId,
  worktreeId: null,
  attemptId: "attempt",
  status: value,
  ...extra,
});

describe("scheduled terminal and retry message branches", () => {
  it("persists a usage-limit retry for a leased run and clears its lease locally", async () => {
    const calls: Record<string, unknown>[] = [];
    const state = durable(session(), {
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        calls.push(input);
        return true;
      },
    });
    await handleHostMessageDurable(
      state,
      status("s", "failed", {
        errorCode: "usage_limit",
        errorMessage: "quota",
        exitCode: 9,
        cliResumeRef: "ref",
      }),
    );
    expect(calls[0]).toMatchObject({
      status: "queued",
      retryCount: 1,
      errorCode: "usage_limit",
      exitCode: 9,
      cliResumeRef: "ref",
    });
    expect(state.sessions.get("s")).toMatchObject({
      status: "queued",
      retryCount: 1,
      hostId: null,
      errorMessage: "quota",
    });
    expect(state.sessions.get("s")).not.toHaveProperty("assignmentConnectionId");
  });

  it("does not mutate when a leased terminal release loses its fence", async () => {
    const row = session();
    const state = durable(row, { releaseMainCheckoutSession: async () => false });
    await handleHostMessageDurable(state, status("s", "completed", { exitCode: 0 }));
    expect(state.sessions.get("s")).toEqual(row);
  });

  it("finishes a leased run at the retry ceiling with complete metadata", async () => {
    const calls: Record<string, unknown>[] = [];
    const row = session({ retryCount: 1 });
    const state = durable(row, {
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        calls.push(input);
        return true;
      },
    });
    await handleHostMessageDurable(
      state,
      status("s", "failed", {
        errorCode: "usage_limit",
        errorMessage: "limit",
        exitCode: 3,
        cliResumeRef: "r",
      }),
    );
    expect(calls[0]).toMatchObject({
      status: "failed",
      completedAt: NOW,
      errorCode: "usage_limit",
      exitCode: 3,
      cliResumeRef: "r",
    });
    expect(state.sessions.get("s")).toMatchObject({
      status: "failed",
      completedAt: NOW,
      errorCode: "usage_limit",
      errorMessage: "limit",
      exitCode: 3,
      cliResumeRef: "r",
    });
  });

  it("releases a cancelled leased run and carries late terminal metadata", async () => {
    const row = session({ status: "cancelled", completedAt: NOW });
    const state = durable(row);
    state.mainCheckoutLeases.set("host\0repo", { sessionId: "s", connectionId: "old" });
    await handleHostMessageDurable(
      state,
      status("s", "cancelled", {
        errorCode: "killed",
        errorMessage: "late",
        exitCode: 2,
        cliResumeRef: "resume",
      }),
    );
    expect(state.sessions.get("s")).toMatchObject({
      status: "cancelled",
      errorCode: "killed",
      errorMessage: "late",
      exitCode: 2,
      cliResumeRef: "resume",
      worktreeId: null,
    });
    expect(state.sessions.get("s")).not.toHaveProperty("mainCheckoutLease");
  });
});
