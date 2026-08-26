/* eslint-disable max-lines -- scheduled terminal branches share one session fixture. */
import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
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
    principalId: "system",
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    hostId: "host",
    assignmentConnectionId: "old",
    assignmentSentAt: NOW,
    ackReceivedAt: NOW,
    startedAt: NOW,
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
  setDurableReadStorage(state, storage(methods));
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
  it("persists a providerless usage-limit fallback for a leased run and clears its lease locally", async () => {
    const calls: Record<string, unknown>[] = [];
    const state = durable(session({ fallbacks: [{ commandId: "fallback" }] }), {
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
      suppressedTargetIndex: 0,
      errorCode: "usage_limit",
      exitCode: 9,
      cliResumeRef: "ref",
    });
    expect(state.sessions.get("s")).toMatchObject({
      status: "queued",
      hostId: null,
      suppressedTargetIndexes: [0],
      errorMessage: "quota",
    });
    expect(state.sessions.get("s")).not.toHaveProperty("assignmentConnectionId");
    expect(state.sessions.get("s")).not.toHaveProperty("retryAfter");
  });

  it("does not mutate when a leased terminal release loses its fence", async () => {
    const row = session();
    const state = durable(row, { releaseMainCheckoutSession: async () => false });
    await handleHostMessageDurable(state, status("s", "completed", { exitCode: 0 }));
    expect(state.sessions.get("s")).toEqual(row);
  });

  it("keeps a leased providerless usage_limit queued until the original deadline", async () => {
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
      status: "queued",
      suppressedTargetIndex: 0,
      errorCode: "usage_limit",
      exitCode: 3,
      cliResumeRef: "r",
    });
    expect(state.sessions.get("s")).toMatchObject({
      status: "queued",
      errorCode: "usage_limit",
      errorMessage: "limit",
      exitCode: 3,
      cliResumeRef: "r",
      suppressedTargetIndexes: [0],
    });
    expect(state.sessions.get("s")).not.toHaveProperty("completedAt");
  });

  it("releases a cancelled leased run and carries late terminal metadata", async () => {
    const lease = {
      concurrencyId: "provider-lease:acct:0",
      providerAccountId: "acct",
      slot: 0,
      attemptId: "attempt",
    };
    const calls: Record<string, unknown>[] = [];
    const row = session({ status: "cancelled", completedAt: NOW, providerAccountLease: lease });
    const state = durable(row, {
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        calls.push(input);
        return true;
      },
    });
    state.providerAccountLeases.set(lease.concurrencyId, {
      sessionId: "s",
      attemptId: "attempt",
      slot: 0,
      hostId: "host",
      providerAccountId: "acct",
    });
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
    expect(calls[0]).toMatchObject({
      providerAccountLease: lease,
      exitCode: 2,
      errorCode: "killed",
      reason: "late",
      cliResumeRef: "resume",
    });
    expect(state.sessions.get("s")).toMatchObject({
      status: "cancelled",
      errorCode: "killed",
      errorMessage: "late",
      exitCode: 2,
      cliResumeRef: "resume",
      worktreeId: null,
    });
    expect(state.sessions.get("s")).not.toHaveProperty("mainCheckoutLease");
    expect(state.providerAccountLeases.size).toBe(0);
  });

  it("cools a cached account when storage cannot load provider accounts", async () => {
    const row = session({
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "acct",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
      },
    });
    const state = durable(row, { requeueMainCheckoutUsageLimitedSession: async () => false });
    state.providerAccounts.set("acct", {
      id: "acct",
      providerId: "p",
      label: "acct",
      usageLimitCooldownSeconds: 60,
      maxConcurrentSessions: 1,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await handleHostMessageDurable(state, status("s", "failed", { errorCode: "usage_limit" }));
    expect(state.sessions.get("s")?.status).toBe("running");
  });

  it("leaves a cancelled lease without an assignment untouched", async () => {
    const row = session({
      status: "cancelled",
      completedAt: NOW,
      hostId: null,
      assignmentConnectionId: undefined,
      mainCheckoutLease: true,
    });
    const state = durable(row);
    await handleHostMessageDurable(state, status("s", "cancelled"));
    expect(state.sessions.get("s")).toMatchObject({
      status: "cancelled",
      mainCheckoutLease: true,
    });
  });
});
