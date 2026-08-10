/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";
import { enforceAckDeadlinesDurable } from "./control-plane-assign.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";

function providerPlane(): ControlPlane {
  const plane = new ControlPlane({
    now: () => "2026-01-01T00:00:00.000Z",
    shardCount: 1,
    idFactory: (() => {
      let id = 0;
      return () => `session-${++id}`;
    })(),
    attemptIdFactory: (() => {
      let id = 0;
      return () => `attempt-${++id}`;
    })(),
  });
  plane.createProvider({ id: "provider", name: "vendor", defaultCommandId: "provider-command" });
  plane.createProviderAccount({
    id: "account",
    providerId: "provider",
    label: "vendor@example.test",
    usageLimitCooldownSeconds: 60,
  });
  plane.createCommand({
    id: "provider-command",
    name: "provider command",
    argv: ["provider"],
    providerId: "provider",
  });
  plane.createCommand({ id: "cli-fallback", name: "CLI fallback", argv: ["cli"] });
  plane.registerHost({
    hostId: "host",
    worktrees: [
      { id: "worktree", name: "worktree", repositoryId: "repo", path: "/work", labels: [] },
    ],
    commandProfiles: [],
  });
  plane.putHostInventory("host", {
    repositories: [
      {
        id: "repo",
        path: "/repo",
        worktrees: [{ id: "worktree", name: "worktree", path: "/work", labels: [] }],
      },
    ],
    providerAccounts: [{ providerAccountId: "account" }],
    commandProfiles: {},
  });
  return plane;
}

describe("routing edge coverage", () => {
  it("pauses a provider account globally and immediately assigns an explicit providerless fallback", () => {
    const plane = providerPlane();
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { providerId: "provider" },
      fallbacks: [{ commandId: "cli-fallback" }],
      timeout: 10,
    });
    expect(created.ok).toBe(true);
    const first = plane.assignQueued()[0]!.session;
    expect(first.resolvedRoute).toMatchObject({ providerAccountId: "account", targetIndex: 0 });
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: first.id,
        worktreeId: first.worktreeId!,
        attemptId: first.attemptId!,
      }).ok,
    ).toBe(true);
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId: first.id,
        worktreeId: first.worktreeId!,
        attemptId: first.attemptId!,
        status: "failed",
        errorCode: "usage_limit",
      }).ok,
    ).toBe(true);
    expect(plane.getProviderAccount("account")?.usageLimitedUntil).toBe("2026-01-01T00:01:00.000Z");
    expect(plane.getSession(first.id)?.status).toBe("running");
    expect(plane.getSession(first.id)?.resolvedRoute).toMatchObject({
      commandId: "cli-fallback",
      targetIndex: 1,
    });
  });

  it("suppresses a providerless limit for this session and rejects stale attempt frames", () => {
    const plane = providerPlane();
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cli-fallback" },
      fallbacks: [{ providerId: "provider" }],
      timeout: 10,
    });
    expect(created.ok).toBe(true);
    const first = plane.assignQueued()[0]!.session;
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId: first.id,
        worktreeId: first.worktreeId!,
        attemptId: "stale-attempt",
        status: "completed",
      }).ok,
    ).toBe(true);
    expect(plane.getSession(first.id)?.status).toBe("running");
    plane.handleHostMessage({
      type: "session:status",
      sessionId: first.id,
      worktreeId: first.worktreeId!,
      attemptId: first.attemptId!,
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession(first.id)?.suppressedTargetIndexes).toEqual([0]);
    expect(plane.getSession(first.id)?.resolvedRoute).toMatchObject({
      providerAccountId: "account",
      targetIndex: 1,
    });
  });

  it("expires a queued session before any capacity becomes available", () => {
    let now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ now: () => now, shardCount: 1 });
    plane.createCommand({ id: "cli", name: "CLI", argv: ["cli"] });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cli" },
      timeout: 10,
      queueTtlSeconds: 1,
    });
    expect(created.ok).toBe(true);
    now = "2026-01-01T00:00:01.000Z";
    expect(plane.assignQueued()).toEqual([]);
    expect(plane.getSession(created.ok ? created.session.id : "")?.errorCode).toBe("queue_expired");
  });

  it("uses durable account cooldown and providerless suppression transitions", async () => {
    const storage = Object.create(null) as DynamoPlaneStorage;
    storage.putProvider = async () => undefined;
    storage.putProviderAccount = async () => undefined;
    const now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ storage, now: () => now, shardCount: 1 });
    addDurableReadDefaults(plane.state);
    plane.createProvider({ id: "provider", name: "vendor" });
    plane.createProviderAccount({
      id: "account",
      providerId: "provider",
      label: "vendor@example.test",
      usageLimitCooldownSeconds: 60,
    });
    const accountSession: SessionRecord = {
      id: "account-session",
      repositoryId: "repo",
      prompt: "p",
      target: { providerId: "provider" },
      fallbacks: [],
      targetLabels: ["vendor"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 10,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: now,
      worktreeId: "worktree",
      hostId: "host",
      attemptId: "attempt",
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "account",
        commandId: "provider-command",
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    };
    let stored = accountSession;
    let accountCooldown: string | undefined;
    storage.getSession = async () => stored;
    storage.getProviderAccount = async () => plane.getProviderAccount("account");
    storage.requeueUsageLimitedSession = async (opts) => {
      accountCooldown = opts.usageLimitedUntil;
      return true;
    };
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: stored.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(accountCooldown).toBe("2026-01-01T00:01:00.000Z");
    expect(plane.getSession(stored.id)?.status).toBe("queued");

    const cliSession: SessionRecord = {
      ...accountSession,
      id: "cli-session",
      attemptId: "attempt-cli",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cli",
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt-cli",
      },
    };
    stored = cliSession;
    let suppressed: number | undefined;
    storage.suppressProviderlessUsageLimit = async (opts) => {
      suppressed = opts.targetIndex;
      return true;
    };
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: stored.id,
      worktreeId: "worktree",
      attemptId: "attempt-cli",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(suppressed).toBe(0);
    expect(plane.getSession(stored.id)?.suppressedTargetIndexes).toEqual([0]);
  });

  it("keeps stale sync frames inert and records terminal optional fields", () => {
    const plane = providerPlane();
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cli-fallback" },
      timeout: 10,
    });
    expect(created.ok).toBe(true);
    const assigned = plane.assignQueued()[0]!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: assigned.id,
      worktreeId: assigned.worktreeId!,
      attemptId: "stale",
    });
    expect(plane.getSession(assigned.id)?.ackReceivedAt).toBeUndefined();
    expect(
      plane.handleHostMessage({
        type: "session:log",
        sessionId: assigned.id,
        stream: "stdout",
        content: "x".repeat(32 * 1024 + 1),
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      }),
    ).toMatchObject({ ok: false });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: assigned.id,
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
      status: "running",
    });
    expect(plane.getSession(assigned.id)?.status).toBe("running");
    plane.handleHostMessage({
      type: "session:status",
      sessionId: assigned.id,
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "setup broke",
      exitCode: 2,
      cliResumeRef: "resume-ref",
    });
    expect(plane.getSession(assigned.id)).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "setup broke",
      exitCode: 2,
      cliResumeRef: "resume-ref",
    });
  });

  it("handles durable stale, missing-account, failed-commit, and terminal branches", async () => {
    const storage = Object.create(null) as DynamoPlaneStorage;
    storage.putArchive = async () => undefined;
    const plane = new ControlPlane({ storage, now: () => "2026-01-01T00:00:00.000Z" });
    addDurableReadDefaults(plane.state);
    const session: SessionRecord = {
      id: "durable",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cli" },
      fallbacks: [],
      targetLabels: ["CLI"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 10,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "worktree",
      attemptId: "attempt",
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "missing-account",
        commandId: "cli",
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    };
    storage.getSession = async () => session;
    storage.getProviderAccount = async () => null;
    expect(
      await plane.handleHostMessageDurable({
        type: "session:status",
        sessionId: session.id,
        worktreeId: "wrong-worktree",
        attemptId: "attempt",
        status: "completed",
      }),
    ).toMatchObject({ ok: true });
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: session.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession(session.id)?.status).toBe("running");
    session.resolvedRoute = { ...session.resolvedRoute!, commandId: "cli" };
    delete session.resolvedRoute.providerAccountId;
    let finish = false;
    storage.finishSession = async () => finish;
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: session.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "completed",
    });
    expect(plane.getSession(session.id)?.status).toBe("running");
    finish = true;
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: session.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "completed",
      exitCode: 0,
      cliResumeRef: "durable-ref",
    });
    expect(plane.getSession(session.id)).toMatchObject({
      status: "completed",
      exitCode: 0,
      cliResumeRef: "durable-ref",
    });
  });

  it("covers durable nonrunning suppression and stale or lost ack-deadline fences", async () => {
    const storage = Object.create(null) as DynamoPlaneStorage;
    const plane = new ControlPlane({ storage, now: () => "2026-01-01T00:00:00.000Z" });
    addDurableReadDefaults(plane.state);
    const session: SessionRecord = {
      id: "edge",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cli" },
      fallbacks: [],
      targetLabels: ["CLI"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 10,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreeId: "worktree",
      hostId: "host",
      attemptId: "attempt",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cli",
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    };
    storage.getSession = async () => session;
    expect(
      await plane.handleHostMessageDurable({
        type: "session:status",
        sessionId: "edge",
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "completed",
      }),
    ).toMatchObject({ ok: true });

    session.status = "running";
    storage.suppressProviderlessUsageLimit = async () => true;
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: "edge",
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("edge")?.suppressedTargetIndexes).toEqual([0]);

    const deadlineSession: SessionRecord = {
      ...session,
      id: "deadline",
      status: "running",
      worktreeId: "deadline-worktree",
      hostId: "host",
      attemptId: "deadline-attempt",
    };
    plane.state.sessions.set(deadlineSession.id, deadlineSession);
    plane.state.pendingAcks.set(deadlineSession.id, {
      sessionId: deadlineSession.id,
      worktreeId: "deadline-worktree",
      attemptId: "deadline-attempt",
      assignedAtMs: 0,
    });
    storage.tryRequeueSession = async () => false;
    expect(await enforceAckDeadlinesDurable(plane.state, 60_000)).toEqual([]);
    plane.state.pendingAcks.set(deadlineSession.id, {
      sessionId: deadlineSession.id,
      worktreeId: "deadline-worktree",
      attemptId: "old-attempt",
      assignedAtMs: 0,
    });
    expect(await enforceAckDeadlinesDurable(plane.state, 60_000)).toEqual([]);
    expect(plane.state.pendingAcks.has(deadlineSession.id)).toBe(false);
  });

  it("handles durable registration, delegated storage-less statuses, and ack fences", async () => {
    const local = new ControlPlane({
      connectionIdFactory: () => "connection",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(
      await local.handleHostMessageDurable({
        type: "host:register",
        hostId: "host",
        worktrees: [],
        commandProfiles: [],
      }),
    ).toEqual({ ok: true, connectionId: "connection" });

    const delegated: SessionRecord = {
      id: "delegated",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cli" },
      fallbacks: [],
      targetLabels: ["CLI"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 10,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreeId: "worktree",
      hostId: "host",
      attemptId: "attempt",
    };
    local.state.sessions.set(delegated.id, delegated);
    expect(
      await handleHostMessageDurable(local.state, {
        type: "session:status",
        sessionId: delegated.id,
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "running",
      }),
    ).toEqual({ ok: true });

    const storage = Object.create(null) as DynamoPlaneStorage;
    const durable = new ControlPlane({ storage });
    addDurableReadDefaults(durable.state);
    const running = { ...delegated, id: "ack", status: "running" as const };
    storage.getSession = async () => running;
    let acknowledged = false;
    storage.acknowledgeSession = async () => {
      acknowledged = true;
      return true;
    };
    durable.state.pendingAcks.set(running.id, {
      sessionId: running.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      assignedAtMs: 0,
    });
    for (const message of [
      { worktreeId: "wrong", attemptId: "attempt" },
      { worktreeId: "worktree", attemptId: "wrong" },
    ]) {
      expect(
        await durable.handleHostMessageDurable({
          type: "session:ack",
          sessionId: running.id,
          ...message,
        }),
      ).toEqual({ ok: true });
    }
    expect(acknowledged).toBe(false);
    await durable.handleHostMessageDurable({
      type: "session:ack",
      sessionId: running.id,
      worktreeId: "worktree",
      attemptId: "attempt",
    });
    expect(acknowledged).toBe(true);
    expect(durable.state.pendingAcks.has(running.id)).toBe(false);
  });

  it("covers durable usage-limit commit outcomes, optional terminal fields, and ack requeues", async () => {
    const storage = Object.create(null) as DynamoPlaneStorage;
    storage.putArchive = async () => undefined;
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z", ackDeadlineMs: 1 });
    plane.registerHost({
      hostId: "host",
      worktrees: [
        { id: "worktree", name: "worktree", repositoryId: "repo", path: "/work", labels: [] },
      ],
      commandProfiles: [],
    });
    plane.state.storage = storage;
    addDurableReadDefaults(plane.state);
    const session: SessionRecord = {
      id: "session",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cli" },
      fallbacks: [],
      targetLabels: ["CLI"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 10,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreeId: "worktree",
      hostId: "host",
      attemptId: "attempt",
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "account",
        commandId: "cli",
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    };
    let stored = session;
    storage.getSession = async () => stored;
    storage.getProviderAccount = async () => ({
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 60,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    let usageError: string | undefined;
    storage.requeueUsageLimitedSession = async (opts) => {
      usageError = opts.errorMessage;
      return true;
    };
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: session.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
      errorMessage: "quota",
    });
    expect(usageError).toBe("quota");
    expect(plane.getWorktree("worktree")).toMatchObject({ status: "idle", currentSessionId: null });

    stored = { ...session, id: "lost-usage" };
    storage.requeueUsageLimitedSession = async () => false;
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: stored.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });

    stored = {
      ...session,
      id: "providerless",
      resolvedRoute: {
        commandId: "cli",
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    };
    storage.suppressProviderlessUsageLimit = async () => false;
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: stored.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });

    stored = { ...session, id: "terminal", resolvedRoute: undefined };
    let terminalWrite: Record<string, unknown> | undefined;
    storage.finishSession = async (opts) => {
      terminalWrite = opts;
      return true;
    };
    await plane.handleHostMessageDurable({
      type: "session:status",
      sessionId: stored.id,
      worktreeId: "worktree",
      attemptId: "attempt",
      status: "timed_out",
      exitCode: 2,
      errorCode: "timeout",
      errorMessage: "too slow",
      cliResumeRef: "resume",
    });
    expect(terminalWrite).toMatchObject({
      exitCode: 2,
      errorCode: "timeout",
      errorMessage: "too slow",
      cliResumeRef: "resume",
    });
    expect(plane.getSession("terminal")).toMatchObject({
      status: "timed_out",
      cliResumeRef: "resume",
    });

    const deadline: SessionRecord = { ...session, id: "deadline", attemptId: "deadline-attempt" };
    plane.state.sessions.set(deadline.id, deadline);
    plane.state.pendingAcks.set(deadline.id, {
      sessionId: deadline.id,
      worktreeId: "worktree",
      attemptId: "deadline-attempt",
      assignedAtMs: 0,
    });
    storage.tryRequeueSession = async () => true;
    expect(await enforceAckDeadlinesDurable(plane.state, 10)).toEqual(["deadline"]);
    expect(plane.getWorktree("worktree")).toMatchObject({ status: "idle", currentSessionId: null });
  });
});
