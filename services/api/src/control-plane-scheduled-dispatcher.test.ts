/* eslint-disable max-lines */
import { describe, expect, it, vi } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { reconcileHostRunningSessions } from "./control-plane-reconnect.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makePlane(over: ConstructorParameters<typeof ControlPlane>[0] = {}) {
  return new ControlPlane({
    now: () => NOW,
    shardCount: 1,
    ...over,
  });
}

function seedCommand(plane: ControlPlane, id = "cmd") {
  expect(
    plane.createCommand({
      id,
      name: id,
      argv: ["agent", "--print"],
      appendPrompt: true,
      providerId: null,
    }),
  ).toMatchObject({ ok: true });
}

function register(
  plane: ControlPlane,
  hostId: string,
  opts: {
    capability?: boolean;
    repositoryId?: string;
    worktrees?: Array<{ id: string; name: string }>;
  } = {},
) {
  const repositoryId = opts.repositoryId ?? "repo-1";
  return plane.registerHost({
    hostId,
    worktrees: (opts.worktrees ?? []).map(({ id, name }) => ({
      id,
      name,
      repositoryId,
      path: `/worktrees/${id}`,
      labels: [],
    })),
    repositories: [{ id: repositoryId, path: `/repos/${repositoryId}`, defaultBranch: "main" }],
    commandProfiles: [],
    capabilities: opts.capability === false ? [] : ["scheduled-main-checkout"],
  });
}

function trigger(
  plane: ControlPlane,
  over: Partial<Parameters<ControlPlane["putSchedule"]>[0]> = {},
) {
  const put = plane.putSchedule({
    id: "schedule-1",
    repositoryId: "repo-1",
    name: "nightly",
    target: { commandId: "cmd" },
    cron: "* * * * *",
    timeout: 30,
    nextRunAt: NOW,
    ...over,
  });
  if (!put.ok) throw new Error(put.error);
  const fired = plane.triggerSchedule(put.schedule.id, NOW);
  if (!fired.ok) throw new Error(fired.error);
  return fired.session;
}

function scheduledFence(plane: ControlPlane, sessionId: string) {
  const attemptId = plane.getSession(sessionId)?.attemptId;
  if (!attemptId) throw new Error(`missing attempt for ${sessionId}`);
  return { worktreeId: null, attemptId } as const;
}

describe("scheduled main-checkout dispatcher", () => {
  it("requires capability, repository inventory, and a live non-draining host", async () => {
    const plane = makePlane();
    seedCommand(plane);
    register(plane, "no-capability", { capability: false });
    register(plane, "wrong-repository", { repositoryId: "repo-2" });
    register(plane, "draining");
    plane.drainHost("draining");
    register(plane, "disconnected");
    const disconnected = plane.state.hostConnection.get("disconnected")!;
    plane.disconnectHost(disconnected);
    register(plane, "leased");
    plane.state.mainCheckoutLeases.set("leased\0repo-1", {
      sessionId: "existing",
      connectionId: "existing-connection",
    });
    register(plane, "eligible");

    const session = trigger(plane);
    const assigned = await plane.assignScheduledQueuedDurable();
    expect(assigned.map(({ hostId }) => hostId)).toEqual(["eligible"]);
    expect(plane.getSession(session.id)?.hostId).toBe("eligible");
  });

  it("assigns a repository with no advertised worktrees and leaves worktrees untouched", async () => {
    const plane = makePlane();
    seedCommand(plane);
    register(plane, "main-only");
    const session = trigger(plane);

    expect(plane.listWorktrees()).toEqual([]);
    await plane.assignScheduledQueuedDurable();

    expect(plane.listWorktrees()).toEqual([]);
    expect(plane.getSession(session.id)).toMatchObject({
      status: "running",
      hostId: "main-only",
      worktreeId: null,
    });
  });

  it("uses the least recently started scheduled host, then returns to the other host", async () => {
    const plane = makePlane({
      idFactory: (() => {
        let n = 0;
        return () => `scheduled-${++n}`;
      })(),
    });
    seedCommand(plane);
    register(plane, "host-a");
    register(plane, "host-b");
    plane.state.sessions.set("old", {
      id: "old",
      repositoryId: "repo-1",
      prompt: "scheduled:old",
      target: { commandId: "cmd" },
      targetLabel: "cmd",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "completed",
      queueShard: 0,
      createdAt: "2025-01-01T00:00:00.000Z",
      type: "scheduled",
      source: "schedule",
      hostId: "host-a",
      startedAt: "2025-12-31T00:00:00.000Z",
    });
    const first = trigger(plane);
    const assignments = await plane.assignScheduledQueuedDurable();
    expect(assignments[0]?.hostId).toBe("host-b");

    // Free the first lease to make the round-robin choice observable again.
    plane.handleHostMessage({
      type: "session:status",
      sessionId: first.id,
      status: "completed",
      ...scheduledFence(plane, first.id),
    });
    const second = trigger(plane, { id: "schedule-2", name: "second" });
    const next = await plane.assignScheduledQueuedDurable();
    expect(next[0]?.hostId).toBe("host-a");
    expect(plane.getSession(second.id)?.hostId).toBe("host-a");
  });

  it("resolves a provider schedule and reroutes after an account usage limit", async () => {
    const plane = makePlane({ idFactory: () => "provider-session" });
    expect(
      plane.createProvider({ id: "provider", name: "claude", defaultCommandId: "provider-cmd" }),
    ).toMatchObject({ ok: true });
    expect(
      plane.createProviderAccount({ id: "account", providerId: "provider", label: "work" }),
    ).toMatchObject({ ok: true });
    expect(
      plane.createProviderAccount({ id: "account-b", providerId: "provider", label: "backup" }),
    ).toMatchObject({ ok: true });
    expect(
      plane.createCommand({
        id: "provider-cmd",
        name: "provider-default",
        argv: ["claude"],
        appendPrompt: true,
        providerId: "provider",
      }),
    ).toMatchObject({ ok: true });
    register(plane, "provider-host");
    const inventory = plane.state.hostInventories.get("provider-host")!;
    plane.state.hostInventories.set("provider-host", {
      ...inventory,
      providerAccounts: [
        { providerAccountId: "account", commandId: "provider-cmd" },
        { providerAccountId: "account-b", commandId: "provider-cmd" },
      ],
    });
    const session = trigger(plane, {
      id: "provider-schedule",
      target: { providerId: "provider" },
    });

    const messages: HostWireMessage[] = [];
    plane.state.onHostMessage = (_hostId, message) => messages.push(message);
    await plane.assignScheduledQueuedDurable();
    expect(plane.getSession(session.id)?.resolvedArgv).toEqual(["claude", "scheduled:nightly"]);
    expect(messages[0]).toMatchObject({
      type: "session:assign",
      repositoryId: "repo-1",
      resolvedArgv: ["claude", "scheduled:nightly"],
      worktreeId: null,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: session.id,
      status: "failed",
      errorCode: "usage_limit",
      ...scheduledFence(plane, session.id),
    });
    await vi.waitFor(() => {
      expect(plane.state.providerAccounts.get("account")?.usageLimitedUntil).toBeTruthy();
      expect(plane.getSession(session.id)).toMatchObject({
        status: "running",
        resolvedRoute: { providerAccountId: "account-b" },
      });
    });
  });

  it("tracks a pending ACK, requeues at the deadline, and releases the lease", async () => {
    const plane = makePlane({ ackDeadlineMs: 10 });
    seedCommand(plane);
    register(plane, "host-1");
    const session = trigger(plane);
    await plane.assignScheduledQueuedDurable();
    expect(plane.state.pendingAcks.get(session.id)?.worktreeId).toBeNull();
    expect(plane.state.mainCheckoutLeases.has("host-1\0repo-1")).toBe(true);

    expect(plane.enforceAckDeadlines(Date.parse(NOW) + 9)).toEqual([]);
    expect(plane.enforceAckDeadlines(Date.parse(NOW) + 10)).toEqual([session.id]);
    expect(plane.getSession(session.id)).toMatchObject({ status: "queued", hostId: null });
    expect(plane.state.mainCheckoutLeases.has("host-1\0repo-1")).toBe(false);
  });

  it("cancels before ACK without confirming execution and releases on the late terminal", async () => {
    const plane = makePlane();
    seedCommand(plane);
    register(plane, "host-1");
    const session = trigger(plane);
    await plane.assignScheduledQueuedDurable();

    expect(plane.cancelSession(session.id)).toMatchObject({ ok: true });
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: session.id,
        ...scheduledFence(plane, session.id),
      }),
    ).toEqual({ ok: true });
    expect(plane.getSession(session.id)?.ackReceivedAt).toBeUndefined();
    plane.handleHostMessage({
      type: "session:status",
      sessionId: session.id,
      status: "cancelled",
      ...scheduledFence(plane, session.id),
    });
    expect(plane.state.mainCheckoutLeases.has("host-1\0repo-1")).toBe(false);
  });

  it("requeues a scheduled assignment that disconnects before ACK", async () => {
    const plane = makePlane();
    seedCommand(plane);
    const registration = register(plane, "host-1");
    const session = trigger(plane);
    await plane.assignScheduledQueuedDurable();

    if (!registration.ok) throw new Error(registration.error);
    expect(plane.disconnectHost(registration.connectionId)).toEqual([session.id]);
    expect(plane.getSession(session.id)).toMatchObject({ status: "queued", hostId: null });
    expect(plane.state.mainCheckoutLeases.has("host-1\0repo-1")).toBe(false);
  });

  it("gives an acknowledged scheduled assignment a reconnect grace period", async () => {
    const plane = makePlane({ reconnectGraceMs: 100 });
    seedCommand(plane);
    const registration = register(plane, "host-1");
    const session = trigger(plane);
    await plane.assignScheduledQueuedDurable();
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: session.id,
      ...scheduledFence(plane, session.id),
    });

    if (!registration.ok) throw new Error(registration.error);
    plane.disconnectHost(registration.connectionId);
    expect(plane.getSession(session.id)?.reconnectDeadlineAt).toBe(
      new Date(Date.parse(NOW) + 100).toISOString(),
    );
    expect(plane.getSession(session.id)?.status).toBe("running");
  });

  it("retries usage-limit failures with backoff and stops at the ceiling", async () => {
    let now = Date.parse(NOW);
    const plane = new ControlPlane({
      now: () => new Date(now).toISOString(),
      idFactory: (() => {
        let n = 0;
        return () => `session-${++n}`;
      })(),
      shardCount: 1,
      usageLimitRetryCeiling: 1,
    });
    seedCommand(plane);
    register(plane, "host-1");
    const first = trigger(plane);
    await plane.assignScheduledQueuedDurable();
    plane.handleHostMessage({
      type: "session:status",
      sessionId: first.id,
      status: "failed",
      errorCode: "usage_limit",
      ...scheduledFence(plane, first.id),
    });
    expect(plane.getSession(first.id)).toMatchObject({ status: "queued", retryCount: 1 });
    now += 2_000;
    await plane.assignScheduledQueuedDurable();
    expect(plane.getSession(first.id)).toMatchObject({ status: "running" });
    expect(plane.getSession(first.id)).not.toHaveProperty("errorCode");
    expect(plane.getSession(first.id)).not.toHaveProperty("errorMessage");
    expect(plane.getSession(first.id)).not.toHaveProperty("retryAfter");
    plane.handleHostMessage({
      type: "session:status",
      sessionId: first.id,
      status: "completed",
      ...scheduledFence(plane, first.id),
    });
    expect(plane.getSession(first.id)).toMatchObject({ status: "completed" });
    expect(plane.getSession(first.id)).not.toHaveProperty("errorCode");
  });
});

describe("scheduled reconnect fencing", () => {
  function runningState() {
    const state = createControlPlaneState({ now: () => NOW, reconnectGraceMs: 100 });
    state.connections.set("old", {
      connectionId: "old",
      type: "host",
      hostId: "host-1",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      repositoryIds: ["repo-1"],
      capabilities: ["scheduled-main-checkout"],
    });
    state.hostConnection.set("host-1", "old");
    state.mainCheckoutLeases.set("host-1\0repo-1", {
      sessionId: "scheduled-1",
      connectionId: "old",
    });
    state.sessions.set("scheduled-1", {
      id: "scheduled-1",
      repositoryId: "repo-1",
      prompt: "scheduled:nightly",
      target: { commandId: "cmd" },
      targetLabel: "cmd",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: NOW,
      startedAt: NOW,
      ackReceivedAt: NOW,
      hostId: "host-1",
      worktreeId: null,
      assignmentConnectionId: "old",
      mainCheckoutLease: true,
      reconnectDeadlineAt: new Date(Date.parse(NOW) + 100).toISOString(),
      type: "scheduled",
      source: "schedule",
    });
    return state;
  }

  it("confirms a reported scheduled session and fences the lease to the new connection", async () => {
    const state = runningState();
    state.connections.set("new", {
      ...state.connections.get("old")!,
      connectionId: "new",
    });
    state.hostConnection.set("host-1", "new");

    expect(await reconcileHostRunningSessions(state, "host-1", ["scheduled-1"])).toEqual([]);
    expect(state.sessions.get("scheduled-1")?.assignmentConnectionId).toBe("new");
    expect(state.mainCheckoutLeases.get("host-1\0repo-1")?.connectionId).toBe("new");
    expect(state.sessions.get("scheduled-1")?.reconnectDeadlineAt).toBeUndefined();
  });

  it("requeues an omitted scheduled session and releases its lease", async () => {
    const state = runningState();
    state.connections.set("new", { ...state.connections.get("old")!, connectionId: "new" });
    state.hostConnection.set("host-1", "new");

    expect(await reconcileHostRunningSessions(state, "host-1", [])).toEqual(["scheduled-1"]);
    expect(state.sessions.get("scheduled-1")).toMatchObject({ status: "queued", hostId: null });
    expect(state.mainCheckoutLeases.has("host-1\0repo-1")).toBe(false);
  });

  it("reclaims a scheduled reconnect after its grace deadline", async () => {
    const state = runningState();
    expect(
      await import("./control-plane-reconnect.ts").then(({ reclaimReconnectDeadlines }) =>
        reclaimReconnectDeadlines(state, Date.parse(NOW) + 99),
      ),
    ).toEqual([]);
    expect(
      await import("./control-plane-reconnect.ts").then(({ reclaimReconnectDeadlines }) =>
        reclaimReconnectDeadlines(state, Date.parse(NOW) + 100),
      ),
    ).toEqual(["scheduled-1"]);
    expect(state.sessions.get("scheduled-1")?.status).toBe("queued");
    expect(state.mainCheckoutLeases.has("host-1\0repo-1")).toBe(false);
  });
});
