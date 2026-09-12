/* eslint-disable max-lines -- command-start and infrastructure-retry paths share one control-plane fixture. */
import { describe, expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { baseSessionBody, seedBaseCommand } from "../test-helpers/control-plane-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(over: Partial<SessionRecord> = {}): SessionRecord {
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
    ...over,
  };
}

function worktree(sessionId = "session"): WorktreeRecord {
  return {
    id: "worktree",
    name: "worktree",
    hostId: "host",
    repositoryId: "repo",
    path: "/worktree",
    labels: [],
    status: "busy",
    online: true,
    currentSessionId: sessionId,
  };
}

function status(
  sessionId: string,
  value: "completed" | "failed",
  extra: Record<string, unknown> = {},
) {
  return {
    type: "session:status" as const,
    sessionId,
    worktreeId: "worktree",
    attemptId: "attempt",
    status: value,
    ...extra,
  };
}

function durable(session: SessionRecord, methods: Record<string, unknown> = {}) {
  const state = createControlPlaneState({ now: () => NOW });
  setDurableReadStorage(state, {
    finishSession: async () => true,
    putArchive: async () => undefined,
    listLogs: async () => [],
    releaseMainCheckoutSession: async () => true,
    tryRequeueSession: async () => true,
    requeueUsageLimitedSession: async () => true,
    ...methods,
  });
  state.sessions.set(session.id, session);
  return state;
}

describe("control-plane host message coverage paths", () => {
  it("rejects a missing local command start and authorizes a pending one before notifying its host", () => {
    const delivered: unknown[] = [];
    const state = createControlPlaneState({
      onHostMessage: (_hostId, message) => delivered.push(message),
    });
    const message = {
      type: "session:command-start" as const,
      sessionId: "session",
      worktreeId: "worktree",
      attemptId: "attempt",
    };

    expect(handleHostMessage(state, message)).toEqual({ ok: false, error: "session not found" });
    state.sessions.set("session", running({ primaryCommandStartState: "pending" }));

    expect(handleHostMessage(state, message)).toEqual({ ok: true });
    expect(state.sessions.get("session")?.primaryCommandStartState).toBe("authorized");
    expect(delivered).toEqual([
      {
        type: "session:command-start-acknowledged",
        sessionId: "session",
        attemptId: "attempt",
      },
    ]);

    const hostless = createControlPlaneState();
    hostless.sessions.set("hostless", running({ id: "hostless", hostId: null }));
    expect(handleHostMessage(hostless, { ...message, sessionId: "hostless" })).toEqual({
      ok: true,
    });
  });

  it("does not acknowledge a missing durable command start and acknowledges only after authorization", async () => {
    const missing = createControlPlaneState();
    setDurableReadStorage(missing, { getSession: async () => null });
    const message = {
      type: "session:command-start" as const,
      sessionId: "session",
      worktreeId: "worktree",
      attemptId: "attempt",
    };
    await expect(handleHostMessageDurable(missing, message)).resolves.toEqual({
      ok: false,
      error: "session not found",
    });

    const authorizePrimaryCommandStart = vi.fn(async () => true);
    const state = durable(running({ primaryCommandStartState: "pending" }), {
      authorizePrimaryCommandStart,
    });
    await expect(handleHostMessageDurable(state, message)).resolves.toEqual({
      ok: true,
      sessionCommandStartAcknowledged: { sessionId: "session", attemptId: "attempt" },
    });
    await expect(handleHostMessageDurable(state, message)).resolves.toEqual({
      ok: true,
      sessionCommandStartAcknowledged: { sessionId: "session", attemptId: "attempt" },
    });
    expect(authorizePrimaryCommandStart).toHaveBeenCalledTimes(1);
  });

  it("requeues local infrastructure failures after releasing either scheduled or worktree capacity", () => {
    const scheduled = createControlPlaneState({ now: () => NOW });
    const scheduledRun = running({
      mainCheckoutLease: true,
      worktreeId: null,
      assignmentConnectionId: "connection",
    });
    scheduled.sessions.set(scheduledRun.id, scheduledRun);
    scheduled.mainCheckoutLeases.set("host\0repo", {
      sessionId: scheduledRun.id,
      connectionId: "connection",
    });
    expect(
      handleHostMessage(
        scheduled,
        status(scheduledRun.id, "failed", {
          worktreeId: null,
          errorCode: "checkout_fetch_failed",
        }),
      ),
    ).toEqual({ ok: true });
    expect(scheduled.sessions.get(scheduledRun.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
      lastInfrastructureErrorCode: "checkout_fetch_failed",
    });
    expect(scheduled.mainCheckoutLeases.size).toBe(0);

    const worktreeState = createControlPlaneState({ now: () => NOW });
    const worktreeRun = running();
    worktreeState.sessions.set(worktreeRun.id, worktreeRun);
    worktreeState.worktrees.set("worktree", worktree());
    expect(
      handleHostMessage(
        worktreeState,
        status(worktreeRun.id, "failed", { errorCode: "checkout_fetch_failed" }),
      ),
    ).toEqual({ ok: true });
    expect(worktreeState.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(worktreeState.sessions.get(worktreeRun.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
    });
  });

  it("immediately reschedules local infrastructure retries for prompts and schedules", async () => {
    const promptPlane = new ControlPlane({
      now: () => NOW,
      idFactory: () => "prompt-session",
      attemptIdFactory: (() => {
        let attempt = 0;
        return () => `prompt-attempt-${++attempt}`;
      })(),
    });
    seedBaseCommand(promptPlane);
    expect(
      promptPlane.registerHost({
        hostId: "prompt-host",
        worktrees: [
          {
            id: "prompt-worktree",
            name: "prompt-worktree",
            repositoryId: "repo-1",
            path: "/prompt-worktree",
            labels: [],
          },
        ],
        commandProfiles: ["echo-prompt"],
      }),
    ).toMatchObject({ ok: true });
    const promptCreated = promptPlane.createSession(baseSessionBody());
    if (!promptCreated.ok) throw new Error(promptCreated.error);
    const [promptAssignment] = promptPlane.assignQueued();
    if (!promptAssignment) throw new Error("prompt was not assigned");

    expect(
      promptPlane.handleHostMessage({
        type: "session:status",
        sessionId: promptCreated.session.id,
        worktreeId: "prompt-worktree",
        attemptId: promptAssignment.session.attemptId!,
        status: "failed",
        errorCode: "checkout_fetch_failed",
        errorMessage: "checkout failed",
      }),
    ).toEqual({ ok: true });
    const retriedPrompt = promptPlane.getSession(promptCreated.session.id);
    expect(retriedPrompt).toMatchObject({
      status: "running",
      worktreeId: "prompt-worktree",
      infrastructureRetryCount: 1,
      attemptId: "prompt-attempt-2",
    });
    expect(retriedPrompt).not.toHaveProperty("errorCode");
    expect(retriedPrompt).not.toHaveProperty("errorMessage");

    const scheduledPlane = new ControlPlane({
      now: () => NOW,
      idFactory: () => "scheduled-session",
      attemptIdFactory: (() => {
        let attempt = 0;
        return () => `scheduled-attempt-${++attempt}`;
      })(),
    });
    seedBaseCommand(scheduledPlane);
    expect(
      scheduledPlane.registerHost({
        hostId: "scheduled-host",
        worktrees: [],
        repositories: [{ id: "repo-1", path: "/repo", defaultBranch: "main" }],
        commandProfiles: [],
        capabilities: ["scheduled-main-checkout"],
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      }),
    ).toMatchObject({ ok: true });
    const scheduled = scheduledPlane.putSchedule({
      id: "schedule",
      repositoryId: "repo-1",
      name: "nightly",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
    });
    if (!scheduled.ok) throw new Error(scheduled.error);
    const scheduledCreated = scheduledPlane.triggerSchedule(scheduled.schedule.id);
    if (!scheduledCreated.ok) throw new Error(scheduledCreated.error);
    await scheduledPlane.assignScheduledQueuedDurable();
    const scheduledAttempt = scheduledPlane.getSession(scheduledCreated.session.id)?.attemptId;
    if (!scheduledAttempt) throw new Error("schedule was not assigned");

    expect(
      scheduledPlane.handleHostMessage({
        type: "session:status",
        sessionId: scheduledCreated.session.id,
        worktreeId: null,
        attemptId: scheduledAttempt,
        status: "failed",
        errorCode: "checkout_fetch_failed",
      }),
    ).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(scheduledPlane.getSession(scheduledCreated.session.id)).toMatchObject({
        status: "running",
        worktreeId: null,
        infrastructureRetryCount: 1,
        attemptId: "scheduled-attempt-2",
      });
    });
  });

  it("persists infrastructure retries for both scheduled leases and ordinary worktrees", async () => {
    const scheduledRun = running({
      mainCheckoutLease: true,
      worktreeId: null,
      assignmentConnectionId: "connection",
      errorMessage: undefined,
    });
    const scheduled = durable(scheduledRun);
    scheduled.mainCheckoutLeases.set("host\0repo", {
      sessionId: scheduledRun.id,
      connectionId: "connection",
    });
    await expect(
      handleHostMessageDurable(
        scheduled,
        status(scheduledRun.id, "failed", {
          worktreeId: null,
          errorCode: "checkout_fetch_failed",
        }),
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { sessionId: scheduledRun.id } });
    expect(scheduled.sessions.get(scheduledRun.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
      lastInfrastructureErrorCode: "checkout_fetch_failed",
    });

    const worktreeRun = running();
    const ordinary = durable(worktreeRun);
    ordinary.worktrees.set("worktree", worktree());
    await expect(
      handleHostMessageDurable(
        ordinary,
        status(worktreeRun.id, "failed", {
          errorCode: "checkout_fetch_failed",
        }),
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { sessionId: worktreeRun.id } });
    expect(ordinary.sessions.get(worktreeRun.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
      errorMessage: "checkout fetch failed; retrying once",
    });
    expect(ordinary.worktrees.get("worktree")).toMatchObject({ status: "idle" });
  });

  it("records a cached provider cooldown and finishes an exhausted infrastructure retry", async () => {
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
    const cooldownRun = running({
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        providerAccountId: account.id,
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    });
    const cooled = durable(cooldownRun, { getProviderAccount: async () => account });
    cooled.worktrees.set("worktree", worktree());
    cooled.providerAccounts.set(account.id, account);
    await expect(
      handleHostMessageDurable(
        cooled,
        status(cooldownRun.id, "failed", { errorCode: "usage_limit", errorMessage: "quota" }),
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { sessionId: cooldownRun.id } });
    expect(cooled.providerAccounts.get(account.id)).toMatchObject({
      usageLimitedUntil: "2026-01-01T00:00:30.000Z",
      lastUsageLimitedAt: NOW,
    });

    const exhaustedRun = running({ infrastructureRetryCount: 1 });
    const finishSession = vi.fn(async () => true);
    const exhausted = durable(exhaustedRun, { finishSession });
    exhausted.worktrees.set("worktree", worktree());
    const result = { summary: "checkout failed", summarySource: "harness" as const };
    await expect(
      handleHostMessageDurable(
        exhausted,
        status(exhaustedRun.id, "failed", {
          errorCode: "checkout_fetch_failed",
          exitCode: 1,
          result,
        }),
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { sessionId: exhaustedRun.id } });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        exitCode: 1,
        result,
      }),
    );
    expect(exhausted.sessions.get(exhaustedRun.id)).toMatchObject({
      status: "failed",
      errorCode: "checkout_fetch_failed",
      exitCode: 1,
      result,
      worktreeId: null,
    });
  });

  it("handles failed and exhausted scheduled lease transitions without treating a lost release as applied", async () => {
    const lostRun = running({
      mainCheckoutLease: true,
      worktreeId: null,
      assignmentConnectionId: "connection",
    });
    const lost = durable(lostRun, { releaseMainCheckoutSession: async () => false });
    await expect(
      handleHostMessageDurable(
        lost,
        status(lostRun.id, "failed", {
          worktreeId: null,
          errorCode: "checkout_fetch_failed",
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(lost.sessions.get(lostRun.id)).toMatchObject({ status: "running" });

    const exhaustedRun = running({
      mainCheckoutLease: true,
      worktreeId: null,
      assignmentConnectionId: "connection",
      infrastructureRetryCount: 1,
    });
    const exhausted = durable(exhaustedRun);
    exhausted.mainCheckoutLeases.set("host\0repo", {
      sessionId: exhaustedRun.id,
      connectionId: "connection",
    });
    await expect(
      handleHostMessageDurable(
        exhausted,
        status(exhaustedRun.id, "failed", {
          worktreeId: null,
          errorCode: "checkout_fetch_failed",
        }),
      ),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: { sessionId: exhaustedRun.id, attemptId: "attempt" },
    });
    expect(exhausted.sessions.get(exhaustedRun.id)).toMatchObject({
      status: "failed",
      errorCode: "checkout_fetch_failed",
      worktreeId: null,
    });
  });

  it("fences a worktree retry, preserves it on a lost requeue, and tolerates a missing cache entry", async () => {
    const retry = running();
    const state = durable(retry, {
      getHostLock: async () => "connection",
      getSession: async () => retry,
    });
    await expect(
      handleHostMessageDurable(
        state,
        status(retry.id, "failed", { errorCode: "checkout_fetch_failed" }),
        "connection",
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { sessionId: retry.id } });
    expect(state.sessions.get(retry.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
    });

    const lostRun = running({ id: "lost-worktree" });
    const lost = durable(lostRun, { tryRequeueSession: async () => false });
    await expect(
      handleHostMessageDurable(
        lost,
        status(lostRun.id, "failed", { errorCode: "checkout_fetch_failed" }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(lost.sessions.get(lostRun.id)).toMatchObject({ status: "running" });
  });

  it("keeps a providerless terminal report queued when no worktree remains to release", async () => {
    const session = running({ id: "providerless", worktreeId: null });
    const state = durable(session);
    await expect(
      handleHostMessageDurable(
        state,
        status(session.id, "failed", {
          worktreeId: null,
          errorCode: "usage_limit",
          errorMessage: "quota",
        }),
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { sessionId: session.id } });
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "queued",
      errorMessage: "quota",
      suppressedTargetIndexes: [0],
    });
  });

  it("finishes an exhausted local infrastructure retry after releasing its worktree", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({ infrastructureRetryCount: 1 });
    state.sessions.set(session.id, session);
    state.worktrees.set("worktree", worktree());

    expect(
      handleHostMessage(
        state,
        status(session.id, "failed", { errorCode: "checkout_fetch_failed" }),
      ),
    ).toEqual({ ok: true });
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "failed",
      errorCode: "checkout_fetch_failed",
      worktreeId: null,
    });
    expect(state.worktrees.get("worktree")).toMatchObject({ status: "idle" });
  });

  it("cools a local provider account and safely leaves an unowned infrastructure retry queued", () => {
    const state = createControlPlaneState({ now: () => NOW });
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
    const cooldownRun = running({
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        providerAccountId: account.id,
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    });
    state.sessions.set(cooldownRun.id, cooldownRun);
    state.worktrees.set("worktree", worktree());
    state.providerAccounts.set(account.id, account);
    expect(
      handleHostMessage(state, status(cooldownRun.id, "failed", { errorCode: "usage_limit" })),
    ).toEqual({ ok: true });
    expect(state.providerAccounts.get(account.id)).toMatchObject({
      usageLimitedUntil: "2026-01-01T00:00:30.000Z",
      lastUsageLimitedAt: NOW,
    });
    expect(state.sessions.get(cooldownRun.id)).toMatchObject({ status: "queued" });

    const orphan = running({ id: "orphan", hostId: null, worktreeId: null });
    state.sessions.set(orphan.id, orphan);
    expect(
      handleHostMessage(
        state,
        status(orphan.id, "failed", { worktreeId: null, errorCode: "checkout_fetch_failed" }),
      ),
    ).toEqual({ ok: true });
    expect(state.sessions.get(orphan.id)).toMatchObject({ status: "running" });
  });

  it("finishes a local scheduled run after releasing its main-checkout lease", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      id: "scheduled-terminal",
      mainCheckoutLease: true,
      worktreeId: null,
      assignmentConnectionId: "connection",
    });
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: session.id,
      connectionId: "connection",
    });
    expect(
      handleHostMessage(state, status(session.id, "completed", { worktreeId: null, exitCode: 0 })),
    ).toEqual({ ok: true });
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "completed",
      completedAt: NOW,
      worktreeId: null,
    });
    expect(state.sessions.get(session.id)).not.toHaveProperty("mainCheckoutLease");
    expect(state.mainCheckoutLeases.size).toBe(0);
  });

  it("finishes a local terminal report with no remaining lease or worktree", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({ id: "unassigned-terminal", hostId: null, worktreeId: null });
    state.sessions.set(session.id, session);

    expect(
      handleHostMessage(state, status(session.id, "completed", { worktreeId: null, exitCode: 0 })),
    ).toEqual({ ok: true });
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "completed",
      completedAt: NOW,
      worktreeId: null,
    });
  });
});
