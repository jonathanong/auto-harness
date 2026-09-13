/* eslint-disable max-lines -- Lambda ingress fencing and delivery lifecycle share one fixture. */
import { DeleteConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  createLambdaHandlers,
  createLambdaRuntime,
  fetchPublicBaseUrl,
  lambdaHydrateCatalogsEnabled,
  loadBootstrapSecrets,
  loadSlackAppCredentials,
  type LambdaRuntime,
} from "./lambda-handlers.ts";
import { resetApiSentryForTests, type SentryClient } from "./sentry.ts";
import * as slackRuntime from "./slack-runtime.ts";

function hostPrincipal(hostId = "host-1") {
  return {
    id: "service-1",
    username: "daemon",
    kind: "service-account" as const,
    role: "agent" as const,
    boundHostId: hostId,
  };
}

function runtimeFixture(principal: ReturnType<typeof hostPrincipal> | null = hostPrincipal()) {
  const connections = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, Record<string, unknown>>();
  const drains = new Map<string, Record<string, unknown>>();
  const inventories = new Map<string, Record<string, unknown>>();
  const mainCheckoutLeases = new Map<string, string>();
  const sessions = new Map<string, Record<string, unknown>>();
  const repositories = new Map<string, Record<string, unknown>>();
  const schedules = new Map<string, Record<string, unknown>>();
  const worktrees = new Map<string, Record<string, unknown>>();
  const hostLocks = new Map<string, string>();
  const deletedConnections: string[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  const schedulerCalls: string[] = [];
  const recordSchedulerCall = (call: string) => {
    schedulerCalls.push(call);
  };
  const storage = {
    async acknowledgeSession(input?: Record<string, unknown>) {
      const sessionId = input?.sessionId;
      const session = sessionId ? sessions.get(String(sessionId)) : undefined;
      if (session) {
        sessions.set(String(sessionId), {
          ...session,
          ackReceivedAt: input?.acknowledgedAt,
        });
      }
      return true;
    },
    async cancelQueuedSession(input: Record<string, unknown>) {
      const sessionId = String(input.sessionId);
      const session = sessions.get(sessionId);
      if (!session || session.status !== "queued") return false;
      sessions.set(sessionId, {
        ...session,
        status: "cancelled",
        completedAt: input.completedAt,
        errorMessage: input.errorMessage,
        cancelledByDrainOperationId: input.drainOperationId,
      });
      return true;
    },
    async deleteConnection(id: string) {
      deletedConnections.push(id);
      connections.delete(id);
    },
    async getConnection(id: string) {
      return connections.get(id) ?? null;
    },
    async getHostLock(hostId: string) {
      return hostLocks.get(hostId) ?? null;
    },
    async getMainCheckoutCursor() {
      return null;
    },
    async getHostInventory() {
      return null;
    },
    async getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    async getRepository(id: string) {
      return repositories.get(id) ?? null;
    },
    async getWorktree(id: string) {
      return worktrees.get(id) ?? null;
    },
    async getSchedule(id: string) {
      return schedules.get(id) ?? null;
    },
    async listCommands() {
      return [...commands.values()];
    },
    async listConnections() {
      recordSchedulerCall("connections");
      return [...connections.values()];
    },
    async listHostInventories() {
      return [...inventories.values()];
    },
    async listLogs() {
      return [];
    },
    async listPendingCancelRedeliveries() {
      return [];
    },
    async listProviderAccounts() {
      return [];
    },
    async listRepositories() {
      recordSchedulerCall("repositories");
      return [...repositories.values()];
    },
    async listAllSessions() {
      recordSchedulerCall("sessions");
      return [...sessions.values()];
    },
    async listAllWorktrees() {
      return [...worktrees.values()];
    },
    async listProviders() {
      return [];
    },
    async listSchedules() {
      recordSchedulerCall("schedules");
      return [...schedules.values()];
    },
    async listSessionDrains() {
      recordSchedulerCall("session-drains");
      return [...drains.values()];
    },
    async listSessionsByStatus(status: string, shard: number) {
      if (status === "running") recordSchedulerCall(`running:${shard}`);
      return [...sessions.values()].filter(
        (session) => session.status === status && session.queueShard === shard,
      );
    },
    async listSessionsForDrain(repositoryId: string, principalId: string) {
      return [...sessions.values()].filter(
        (session) => session.repositoryId === repositoryId && session.principalId === principalId,
      );
    },
    async listWorktreesByHost(hostId: string) {
      return [...worktrees.values()].filter((worktree) => worktree.hostId === hostId);
    },
    async listWorktreesForRepo(repositoryId: string) {
      return [...worktrees.values()].filter((worktree) => worktree.repositoryId === repositoryId);
    },
    async completeRepositoryDrain(id: string, requestedAt: string, now: string) {
      const current = repositories.get(id);
      if (!current || current.drainRequestedAt !== requestedAt) return null;
      const completed = {
        ...current,
        admissionState: "paused",
        admissionStateChangedAt: now,
        drainCompletedAt: now,
      };
      repositories.set(id, completed);
      return completed;
    },
    async markHostDraining(hostId: string, connectionId: string) {
      return hostLocks.get(hostId) === connectionId;
    },
    async migrateSessionDrainActivityLedgerPage() {
      recordSchedulerCall("migration");
      return true;
    },
    async putConnection(connection: Record<string, unknown>) {
      connections.set(String(connection.connectionId), connection);
    },
    async putArchive() {},
    async queryLogs() {
      return [];
    },
    async putHostInventory(record: Record<string, unknown>) {
      inventories.set(String(record.hostId), record);
    },
    async putHostInventoryFenced() {
      return { ok: true };
    },
    async putWorktreeFenced(record: Record<string, unknown>) {
      worktrees.set(String(record.id), record);
      return true;
    },
    async releaseMainCheckoutSession(input: Record<string, unknown>) {
      const session = sessions.get(String(input.sessionId));
      if (!session) return false;
      const leaseKey = `${String(input.hostId)}#${String(input.repositoryId)}`;
      if (mainCheckoutLeases.get(leaseKey) !== input.sessionId) return false;
      mainCheckoutLeases.delete(leaseKey);
      sessions.set(String(input.sessionId), {
        ...session,
        status: input.status,
        worktreeId: null,
        hostId: null,
        ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      });
      return true;
    },
    async releaseHostConnection(hostId: string, connectionId: string) {
      recordSchedulerCall("stale-release");
      if (hostLocks.get(hostId) !== connectionId) return false;
      hostLocks.delete(hostId);
      connections.delete(connectionId);
      return true;
    },
    async setWorktreeOnlineFenced() {
      return true;
    },
    async tryAssignMainCheckoutSession(input: Record<string, unknown>) {
      const session = sessions.get(String(input.sessionId));
      if (!session || session.status !== "queued") return false;
      const leaseKey = `${String(input.hostId)}#${String(input.repositoryId)}`;
      if (mainCheckoutLeases.has(leaseKey)) return false;
      mainCheckoutLeases.set(leaseKey, String(input.sessionId));
      sessions.set(String(input.sessionId), {
        ...session,
        status: "running",
        hostId: input.hostId,
        attemptId: input.attemptId,
        assignmentConnectionId: input.connectionId,
        assignmentSentAt: input.now,
        mainCheckoutLease: true,
      });
      return true;
    },
    async tryAssignSession(input: Record<string, unknown>) {
      const session = sessions.get(String(input.sessionId));
      const worktree = worktrees.get(String(input.worktreeId));
      if (!session || session.status !== "queued" || !worktree || worktree.status !== "idle") {
        return false;
      }
      sessions.set(String(input.sessionId), {
        ...session,
        status: "running",
        worktreeId: input.worktreeId,
        hostId: input.hostId,
        attemptId: input.attemptId,
      });
      worktrees.set(String(input.worktreeId), {
        ...worktree,
        status: "busy",
        currentSessionId: input.sessionId,
      });
      return true;
    },
    async tryClaimScheduleAndCreateSession(input: Record<string, unknown>) {
      const schedule = schedules.get(String(input.scheduleId));
      if (!schedule || schedule.nextRunAt !== input.expectedNextRunAt) return { kind: "lost" };
      const session = input.session as Record<string, unknown>;
      const activeDrain = [...drains.values()].find(
        (drain) =>
          drain.recordKey === "CURRENT" &&
          drain.status === "draining" &&
          drain.repositoryId === session.repositoryId &&
          drain.principalId === session.principalId,
      );
      if (activeDrain) {
        return { kind: "draining", operationId: activeDrain.operationId };
      }
      schedules.set(String(input.scheduleId), {
        ...schedule,
        nextRunAt: input.newNextRunAt,
        lastRunAt: input.lastRunAt,
      });
      sessions.set(String(session.id), session);
      return { kind: "created" };
    },
    async tryRequeueSession(input: Record<string, unknown>) {
      const session = sessions.get(String(input.sessionId));
      if (!session) return false;
      sessions.set(String(input.sessionId), {
        ...session,
        status: "queued",
        worktreeId: null,
        hostId: null,
      });
      return true;
    },
    async ensureMainCheckoutLeaseMap() {
      return true;
    },
    async updateSessionDrain(record: Record<string, unknown>) {
      drains.set(String(record.operationId), record);
      return true;
    },
    async tryRegisterHost(input: Record<string, unknown>) {
      registrations.push(input);
      const connection = input.connection as Record<string, unknown>;
      const connectionId = String(connection.connectionId);
      const hostId = String(input.hostId);
      const pending = connections.get(connectionId);
      if (
        input.consumePendingConnection === true &&
        (!pending ||
          pending.registered !== false ||
          pending.connectionId !== connectionId ||
          pending.hostId !== hostId)
      )
        return false;
      const owner = hostLocks.get(hostId);
      if (owner && input.replaceExisting !== true) return false;
      if (owner && owner !== connectionId) connections.delete(owner);
      connections.set(connectionId, connection);
      hostLocks.set(hostId, connectionId);
      return true;
    },
    async heartbeatConnection(hostId: string, connectionId: string, at: string) {
      if (hostLocks.get(hostId) !== connectionId) return false;
      const connection = connections.get(connectionId);
      if (!connection) return false;
      connections.set(connectionId, { ...connection, lastHeartbeatAt: at });
      return true;
    },
  };
  const plane = new ControlPlane({
    attemptIdFactory: () => "attempt-1",
    connectionIdFactory: () => "gateway-1",
    now: () => "2026-08-12T00:00:00.000Z",
    storage: storage as never,
  });
  const auth = {
    authenticate: vi.fn(async () => principal),
    authenticateViewerTicket: vi.fn(async () => ({
      id: "user:viewer",
      username: "viewer",
      kind: "user" as const,
      role: "operator" as const,
      allowedRepositoryIds: ["repository-1"],
    })),
  };
  const management = { send: vi.fn(async () => ({})) };
  return {
    auth,
    connections,
    commands,
    deletedConnections,
    drains,
    hostLocks,
    inventories,
    mainCheckoutLeases,
    management,
    plane,
    registrations,
    repositories,
    runtime: createLambdaRuntime({
      auth: auth as never,
      created: { plane, storage } as never,
      management,
    }),
    sessions,
    schedules,
    schedulerCalls,
    storage,
    worktrees,
  };
}

async function registerGatewayHost(
  fixture: ReturnType<typeof runtimeFixture>,
  connectionId = "gateway-1",
  protocolVersion?: number,
) {
  const runtime = await fixture.runtime;
  await runtime.websocket({
    requestContext: { connectionId, routeKey: "$connect" },
  });
  await runtime.websocket({
    body: JSON.stringify({
      type: "host:register",
      hostId: "host-1",
      worktrees: [],
      commandProfiles: [],
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    }),
    requestContext: { connectionId, routeKey: "$default" },
  });
  return runtime;
}

function schedulerSession(
  id: string,
  type: "prompt" | "scheduled",
  over: Record<string, unknown> = {},
) {
  return {
    id,
    repositoryId: "repo-active",
    prompt: id,
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-08-13T00:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    type,
    source: type === "scheduled" ? "schedule" : "api",
    principalId: "principal",
    ...over,
  };
}

function seedSchedulerSweep(fixture: ReturnType<typeof runtimeFixture>) {
  fixture.commands.set("cmd", {
    id: "cmd",
    name: "cmd",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  fixture.repositories.set("repo-active", {
    id: "repo-active",
    name: "active",
    url: "url",
    defaultBranch: "main",
    admissionState: "active",
    createdAt: "created",
    updatedAt: "updated",
  });
  fixture.repositories.set("repo-draining", {
    id: "repo-draining",
    name: "draining",
    url: "url",
    defaultBranch: "main",
    admissionState: "draining",
    drainRequestedAt: "requested",
    createdAt: "created",
    updatedAt: "updated",
  });
  for (const id of ["repo-ack", "repo-timeout"]) {
    fixture.repositories.set(id, {
      id,
      name: id,
      url: "url",
      defaultBranch: "main",
      admissionState: "active",
      createdAt: "created",
      updatedAt: "updated",
    });
  }
  fixture.repositories.set("repo-paused", {
    id: "repo-paused",
    name: "paused",
    url: "url",
    defaultBranch: "main",
    admissionState: "paused",
    createdAt: "created",
    updatedAt: "updated",
  });
  fixture.connections.set("active-connection", {
    hostId: "active-host",
    connectionId: "active-connection",
    type: "host",
    connectedAt: "2026-08-12T00:00:00.000Z",
    lastHeartbeatAt: "2099-01-01T00:00:00.000Z",
    commandProfiles: [],
    capabilities: ["scheduled-main-checkout"],
    repositoryIds: ["repo-active", "repo-ack", "repo-timeout"],
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    protocolVersion: 1,
  });
  fixture.connections.set("stale-connection", {
    hostId: "stale-host",
    connectionId: "stale-connection",
    type: "host",
    connectedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    commandProfiles: [],
    capabilities: [],
    repositoryIds: ["repo-paused"],
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
  });
  fixture.hostLocks.set("active-host", "active-connection");
  fixture.hostLocks.set("stale-host", "stale-connection");
  fixture.inventories.set("active-host", {
    hostId: "active-host",
    repositories: ["repo-active", "repo-ack", "repo-timeout"].map((id) => ({
      id,
      path: `/${id}`,
      defaultBranch: "main",
      worktrees: [],
    })),
    providerAccounts: [],
    commandProfiles: {},
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  fixture.worktrees.set("active-worktree", {
    id: "active-worktree",
    name: "active-worktree",
    hostId: "active-host",
    repositoryId: "repo-active",
    path: "/repo-active/worktree",
    labels: [],
    status: "idle",
    online: true,
    connectionId: "active-connection",
  });
  fixture.worktrees.set("stale-worktree", {
    id: "stale-worktree",
    name: "stale-worktree",
    hostId: "stale-host",
    repositoryId: "repo-paused",
    path: "/repo-paused/worktree",
    labels: [],
    status: "busy",
    currentSessionId: "stale-session",
    online: true,
    connectionId: "stale-connection",
  });
  fixture.sessions.set(
    "ack-session",
    schedulerSession("ack-session", "scheduled", {
      repositoryId: "repo-ack",
      status: "running",
      startedAt: "2026-08-12T00:00:00.000Z",
      assignmentSentAt: "2026-01-01T00:00:00.000Z",
      attemptId: "ack-attempt",
      hostId: "active-host",
      worktreeId: null,
      assignmentConnectionId: "active-connection",
      mainCheckoutLease: true,
    }),
  );
  fixture.sessions.set(
    "timeout-session",
    schedulerSession("timeout-session", "scheduled", {
      repositoryId: "repo-timeout",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      ackReceivedAt: "2026-01-01T00:00:00.000Z",
      attemptId: "timeout-attempt",
      hostId: "active-host",
      worktreeId: null,
      assignmentConnectionId: "active-connection",
      mainCheckoutLease: true,
    }),
  );
  fixture.mainCheckoutLeases.set("active-host#repo-ack", "ack-session");
  fixture.mainCheckoutLeases.set("active-host#repo-timeout", "timeout-session");
  fixture.sessions.set(
    "stale-session",
    schedulerSession("stale-session", "prompt", {
      repositoryId: "repo-paused",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      attemptId: "stale-attempt",
      hostId: "stale-host",
      worktreeId: "stale-worktree",
    }),
  );
  fixture.sessions.set("queued-session", schedulerSession("queued-session", "prompt"));
  fixture.schedules.set("due-schedule", {
    id: "due-schedule",
    repositoryId: "repo-active",
    name: "due",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    cron: "* * * * *",
    enabled: true,
    timeout: 30,
    queueTtlSeconds: 3600,
    nextRunAt: "2026-08-12T00:00:00.000Z",
    lastRunAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    principalId: "drain-principal",
  });
  fixture.drains.set("drain-operation", {
    scopeKey: "repo-active#principal",
    recordKey: "CURRENT",
    operationId: "drain-operation",
    repositoryId: "repo-active",
    principalId: "principal",
    status: "draining",
    requestedAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    deadlineAt: "2026-08-13T00:00:00.000Z",
    queuedCount: 0,
    runningCount: 0,
    cancelledCount: 0,
  });
}

describe("Lambda runtime adapters", () => {
  it("authenticates connect once and fences the socket to its bound host", async () => {
    const fixture = runtimeFixture();
    const runtime = await fixture.runtime;
    const connect = {
      headers: { authorization: "Bearer hns_test" },
      requestContext: { connectionId: "gateway-1", routeKey: "$connect" as const },
    };

    await expect(runtime.websocket(connect)).resolves.toEqual({ statusCode: 200 });
    expect(fixture.connections.get("gateway-1")).toMatchObject({
      hostId: "host-1",
      registered: false,
    });
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 403 });
    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "session:ack",
          sessionId: "session-1",
          worktreeId: null,
          attemptId: "attempt-1",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 409 });
    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "host:keepalive",
          hostId: "host-1",
          at: "2026-08-12T00:00:00.000Z",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 409 });
    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "host:register",
          hostId: "other-host",
          worktrees: [],
          commandProfiles: [],
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 403 });

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "host:register",
          hostId: "host-1",
          worktrees: [],
          commandProfiles: [],
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.plane.getHostConnectionId("host-1")).toBe("gateway-1");
    expect(fixture.registrations[0]).toMatchObject({ consumePendingConnection: true });
    expect(fixture.connections.get("gateway-1")?.registered).toBeUndefined();
    // Earlier steps in this test intentionally sent a couple of rejected frames
    // (an empty body, and a hostId mismatch) that now also force-close the stale
    // connection, adding earlier management.send calls — so find the actual
    // registration push by its payload rather than assuming it's call index 0.
    const registeredPush = fixture.management.send.mock.calls
      .map((call) => call[0].input.Data)
      .filter((data): data is Buffer | string => data !== undefined)
      .map((data) => JSON.parse(String(data)))
      .find((payload) => payload.type === "host:registered");
    expect(registeredPush).toEqual({
      type: "host:registered",
      hostId: "host-1",
      connectionId: "gateway-1",
      protocolVersion: HOST_PROTOCOL_VERSION,
    });
  });

  it("acks a successful host keepalive over postToConnection and skips a rejected one", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      fixture.management.send.mockClear();
      await expect(
        runtime.websocket({
          body: JSON.stringify({
            type: "host:keepalive",
            hostId: "host-1",
            at: "2026-08-12T00:00:20.000Z",
          }),
          requestContext: { connectionId: "gateway-1", routeKey: "$default" },
        }),
      ).resolves.toEqual({ statusCode: 200 });
      const keepaliveAcks = fixture.management.send.mock.calls
        .map((call) => call[0].input.Data)
        .filter((data): data is Buffer | string => data !== undefined)
        .map((data) => JSON.parse(String(data)))
        .filter((payload: { type?: string }) => payload.type === "host:keepalive-ack");
      expect(keepaliveAcks).toEqual([
        {
          type: "host:keepalive-ack",
          hostId: "host-1",
          at: "2026-08-12T00:00:20.000Z",
        },
      ]);
      expect(consoleLog.mock.calls.some(([line]) => String(line).includes("postToHost"))).toBe(
        false,
      );

      fixture.management.send.mockClear();
      fixture.hostLocks.set("host-1", "other-connection");
      await expect(
        runtime.websocket({
          body: JSON.stringify({
            type: "host:keepalive",
            hostId: "host-1",
            at: "2026-08-12T00:00:40.000Z",
          }),
          requestContext: { connectionId: "gateway-1", routeKey: "$default" },
        }),
      ).resolves.toEqual({ statusCode: 409 });
      expect(
        fixture.management.send.mock.calls
          .map((call) => call[0].input.Data)
          .filter((data): data is Buffer | string => data !== undefined)
          .map((data) => JSON.parse(String(data)))
          .filter((payload: { type?: string }) => payload.type === "host:keepalive-ack"),
      ).toEqual([]);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("delivers host:keepalive-ack on the current connection even if this container's hostConnection cache missed it", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.plane.state.hostConnection.delete("host-1");
    fixture.management.send.mockClear();

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "host:keepalive",
          hostId: "host-1",
          at: "2026-08-12T00:00:20.000Z",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(
      fixture.management.send.mock.calls.map((call) => JSON.parse(String(call[0].input.Data))),
    ).toContainEqual({
      type: "host:keepalive-ack",
      hostId: "host-1",
      at: "2026-08-12T00:00:20.000Z",
    });
  });

  it("swallows a failed host:keepalive-ack delivery instead of failing the invocation", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.management.send.mockClear();
    const error = new Error("management unavailable");
    fixture.management.send.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        runtime.websocket({
          body: JSON.stringify({
            type: "host:keepalive",
            hostId: "host-1",
            at: "2026-08-12T00:00:20.000Z",
          }),
          requestContext: { connectionId: "gateway-1", routeKey: "$default" },
        }),
      ).resolves.toEqual({ statusCode: 200 });
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('"msg":"postToHost failure"'),
      );
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("management unavailable"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("refreshes durable authentication before accepting a new socket", async () => {
    const fixture = runtimeFixture();
    const refreshAuth = vi.fn(async () => undefined);
    const runtime = await createLambdaRuntime({
      auth: fixture.auth as never,
      created: { plane: fixture.plane, storage: fixture.storage } as never,
      management: fixture.management,
      refreshAuth,
    });

    await runtime.websocket({
      requestContext: { connectionId: "fresh", routeKey: "$connect" },
    });
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(refreshAuth.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.auth.authenticate.mock.invocationCallOrder[0]!,
    );
  });

  it("refetches a missing public base URL before accepting a viewer socket", async () => {
    const fixture = runtimeFixture();
    fixture.plane.state.publicBaseUrl = undefined as unknown as string;
    const previousParam = process.env.PUBLIC_BASE_URL_SSM_PARAM;
    const previousWs = process.env.WS_API_ENDPOINT;
    const send = vi.fn(async () => ({ Parameter: { Value: "https://d1234.cloudfront.net" } }));
    try {
      process.env.PUBLIC_BASE_URL_SSM_PARAM = "/auto-harness/qa/public-base-url";
      process.env.WS_API_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/prod";
      const runtime = await createLambdaRuntime({
        auth: fixture.auth as never,
        created: { plane: fixture.plane, storage: fixture.storage } as never,
        management: fixture.management,
        ssmClient: { send } as never,
      });
      await expect(
        runtime.websocket({
          headers: { origin: "https://d1234.cloudfront.net" },
          queryStringParameters: { ticket: "viewer-ticket" },
          requestContext: { connectionId: "viewer-refetch", routeKey: "$connect" },
        }),
      ).resolves.toEqual({ statusCode: 200 });
      expect(send).toHaveBeenCalled();
    } finally {
      if (previousParam === undefined) delete process.env.PUBLIC_BASE_URL_SSM_PARAM;
      else process.env.PUBLIC_BASE_URL_SSM_PARAM = previousParam;
      if (previousWs === undefined) delete process.env.WS_API_ENDPOINT;
      else process.env.WS_API_ENDPOINT = previousWs;
    }
  });

  it("rehydrates auth on connect when the runtime constructed AuthService itself", async () => {
    const fixture = runtimeFixture();
    const previous = {
      admins: process.env.HARNESS_ADMINS_SSM_PARAM,
      session: process.env.HARNESS_SESSION_SECRET_SSM_PARAM,
      cursor: process.env.HARNESS_CURSOR_SECRET_SSM_PARAM,
      ws: process.env.WS_API_ENDPOINT,
    };
    const admins = Buffer.from(
      JSON.stringify([{ username: "admin", password: "admin-password" }]),
    ).toString("base64url");
    Object.assign(fixture.storage, {
      listAuthAccounts: async () => [
        {
          id: "user:alice",
          kind: "user",
          username: "alice",
          role: "operator",
          passwordHash: "hash",
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    });
    const send = vi.fn(async (command: { input: { Name: string } }) => {
      const name = command.input.Name;
      if (name.includes("admins")) return { Parameter: { Value: admins } };
      return { Parameter: { Value: "s".repeat(32) } };
    });
    try {
      process.env.HARNESS_ADMINS_SSM_PARAM = "/auto-harness/admins";
      process.env.HARNESS_SESSION_SECRET_SSM_PARAM = "/auto-harness/session-secret";
      process.env.HARNESS_CURSOR_SECRET_SSM_PARAM = "/auto-harness/cursor-secret";
      process.env.WS_API_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/prod";
      const runtime = await createLambdaRuntime({
        created: { plane: fixture.plane, storage: fixture.storage } as never,
        management: fixture.management,
        ssmClient: { send } as never,
      });
      await expect(
        runtime.websocket({
          requestContext: { connectionId: "self-auth", routeKey: "$connect" },
        }),
      ).resolves.toMatchObject({ statusCode: expect.any(Number) });
      expect(send).toHaveBeenCalled();
    } finally {
      if (previous.admins === undefined) delete process.env.HARNESS_ADMINS_SSM_PARAM;
      else process.env.HARNESS_ADMINS_SSM_PARAM = previous.admins;
      if (previous.session === undefined) delete process.env.HARNESS_SESSION_SECRET_SSM_PARAM;
      else process.env.HARNESS_SESSION_SECRET_SSM_PARAM = previous.session;
      if (previous.cursor === undefined) delete process.env.HARNESS_CURSOR_SECRET_SSM_PARAM;
      else process.env.HARNESS_CURSOR_SECRET_SSM_PARAM = previous.cursor;
      if (previous.ws === undefined) delete process.env.WS_API_ENDPOINT;
      else process.env.WS_API_ENDPOINT = previous.ws;
    }
  });

  it("routes viewer tickets and read-only messages through the Lambda viewer adapter", async () => {
    const fixture = runtimeFixture();
    fixture.sessions.set("session-1", {
      id: "session-1",
      repositoryId: "repository-1",
      status: "running",
    });
    const runtime = await fixture.runtime;
    await expect(
      runtime.websocket({
        queryStringParameters: { ticket: "viewer-ticket" },
        requestContext: { connectionId: "viewer-1", routeKey: "$connect" },
      }),
    ).resolves.toEqual({ statusCode: 403 });
    await expect(
      runtime.websocket({
        headers: { Origin: "https://evil.example.test" },
        queryStringParameters: { ticket: "viewer-ticket" },
        requestContext: { connectionId: "viewer-2", routeKey: "$connect" },
      }),
    ).resolves.toEqual({ statusCode: 403 });
    await expect(
      runtime.websocket({
        headers: { origin: "http://localhost:7421" },
        queryStringParameters: { ticket: "viewer-ticket" },
        requestContext: { connectionId: "viewer-1", routeKey: "$connect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.connections.get("viewer-1")).toMatchObject({ type: "client" });
    await expect(
      runtime.websocket({
        body: JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
        requestContext: { connectionId: "viewer-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(
      JSON.parse(String(fixture.management.send.mock.calls.at(-1)?.[0].input.Data)),
    ).toMatchObject({ type: "session:subscribed", sessionId: "session-1" });
    fixture.management.send.mockClear();
    fixture.plane.state.onLogCommitted?.({
      sessionId: "session-1",
      timestampSeq: "2026-08-12T00:00:01.000Z#0000000001",
      seq: 1,
      stream: "stdout",
      content: "hosted log",
      timestamp: "2026-08-12T00:00:01.000Z",
    });
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fixture.management.send.mock.calls[0]?.[0].input.Data))).toMatchObject(
      {
        type: "session:log",
        sessionId: "session-1",
        content: "hosted log",
      },
    );
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "viewer-1", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.connections.has("viewer-1")).toBe(false);
  });

  it("preserves an existing log callback and rejects malformed client connection rows", async () => {
    const fixture = runtimeFixture();
    const previous = vi.fn();
    fixture.plane.state.onLogCommitted = previous;
    const runtime = await createLambdaRuntime({
      auth: fixture.auth as never,
      created: { plane: fixture.plane, storage: fixture.storage } as never,
      management: fixture.management,
    });
    const record = {
      sessionId: "session-1",
      timestampSeq: "2026-08-12T00:00:01.000Z#0000000001",
      seq: 1,
      stream: "stdout" as const,
      content: "log",
      timestamp: "2026-08-12T00:00:01.000Z",
    };
    fixture.plane.state.onLogCommitted?.(record);
    expect(previous).toHaveBeenCalledWith(record);
    fixture.connections.set("viewer-1", {
      connectionId: "viewer-1",
      type: "client",
      hostId: "user:viewer",
      connectedAt: "now",
      lastHeartbeatAt: "now",
      viewerSubscriptions: [
        { sessionId: "session-1", repositoryId: "repository-1", status: "running" },
      ],
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fixture.management.send.mockRejectedValueOnce(new Error("gone"));
    fixture.plane.state.onLogCommitted?.(record);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "failed to deliver API Gateway viewer message",
        expect.any(Error),
      ),
    );
    error.mockRestore();

    fixture.connections.set("client-without-principal", {
      connectionId: "client-without-principal",
      type: "client",
      hostId: "viewer",
      connectedAt: "now",
      lastHeartbeatAt: "now",
    });
    await expect(
      runtime.websocket({
        body: "{}",
        requestContext: { connectionId: "client-without-principal", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 403 });
  });

  it("awaits direct durable confirmations before completing an invocation", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.management.send.mockClear();
    fixture.sessions.set("session-1", {
      id: "session-1",
      repositoryId: "repository-1",
      prompt: "test",
      target: "default",
      fallbacks: [],
      targetDisplayNames: ["default"],
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      hostId: "host-1",
      worktreeId: null,
      attemptId: "attempt-1",
    });
    let release: (() => void) | undefined;
    fixture.management.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    let settled = false;
    const acknowledgement = runtime
      .websocket({
        body: JSON.stringify({
          type: "session:ack",
          sessionId: "session-1",
          worktreeId: null,
          attemptId: "attempt-1",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release!();
    await expect(acknowledgement).resolves.toEqual({ statusCode: 200 });
    expect(JSON.parse(String(fixture.management.send.mock.calls[0]?.[0].input.Data))).toEqual({
      type: "session:acknowledged",
      sessionId: "session-1",
      attemptId: "attempt-1",
    });

    await expect(
      runtime.websocket({
        body: JSON.stringify({ type: "host:status", hostId: "host-1", draining: true }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(
      fixture.management.send.mock.calls.map((call) => JSON.parse(String(call[0].input.Data))),
    ).toContainEqual({ type: "host:draining", hostId: "host-1" });
  });

  it("delivers session:acknowledged on the inbound connection after a host cache miss", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.plane.state.hostConnection.delete("host-1");
    fixture.management.send.mockClear();
    fixture.sessions.set("session-ack-cache-miss", {
      id: "session-ack-cache-miss",
      repositoryId: "repository-1",
      prompt: "test",
      target: "default",
      fallbacks: [],
      targetDisplayNames: ["default"],
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      hostId: "host-1",
      worktreeId: null,
      attemptId: "attempt-cache-miss",
    });

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "session:ack",
          sessionId: "session-ack-cache-miss",
          worktreeId: null,
          attemptId: "attempt-cache-miss",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });

    expect(fixture.management.send.mock.calls[0]?.[0].input.ConnectionId).toBe("gateway-1");
    expect(
      fixture.management.send.mock.calls.map((call) => JSON.parse(String(call[0].input.Data))),
    ).toContainEqual({
      type: "session:acknowledged",
      sessionId: "session-ack-cache-miss",
      attemptId: "attempt-cache-miss",
    });
  });

  it("delivers session:acknowledged on the inbound connection despite a stale host cache", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.plane.state.hostConnection.set("host-1", "replaced-connection");
    fixture.management.send.mockClear();
    fixture.sessions.set("session-ack-stale-cache", {
      id: "session-ack-stale-cache",
      repositoryId: "repository-1",
      prompt: "test",
      target: "default",
      fallbacks: [],
      targetDisplayNames: ["default"],
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      hostId: "host-1",
      worktreeId: null,
      attemptId: "attempt-stale-cache",
    });

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "session:ack",
          sessionId: "session-ack-stale-cache",
          worktreeId: null,
          attemptId: "attempt-stale-cache",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });

    expect(fixture.management.send.mock.calls[0]?.[0].input.ConnectionId).toBe("gateway-1");
    expect(
      fixture.management.send.mock.calls.map((call) => JSON.parse(String(call[0].input.Data))),
    ).toContainEqual({
      type: "session:acknowledged",
      sessionId: "session-ack-stale-cache",
      attemptId: "attempt-stale-cache",
    });
  });

  it("replies with session:status-acknowledged after a durable terminal report commits", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.management.send.mockClear();
    fixture.mainCheckoutLeases.set("host-1#repository-1", "session-2");
    fixture.sessions.set("session-2", {
      id: "session-2",
      repositoryId: "repository-1",
      prompt: "test",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["cmd"],
      queueTtlSeconds: 3600,
      queueExpiresAt: "2026-08-13T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      type: "scheduled",
      source: "schedule",
      principalId: "system",
      hostId: "host-1",
      worktreeId: null,
      attemptId: "attempt-2",
      mainCheckoutLease: true,
      assignmentConnectionId: "gateway-1",
    });

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "session:status",
          sessionId: "session-2",
          worktreeId: null,
          attemptId: "attempt-2",
          status: "completed",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(
      fixture.management.send.mock.calls.map((call) => JSON.parse(String(call[0].input.Data))),
    ).toContainEqual({
      type: "session:status-acknowledged",
      sessionId: "session-2",
      attemptId: "attempt-2",
    });
  });

  it("uses the authenticated durable protocol on a cold process cache", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture, "gateway-1", 3);
    fixture.plane.state.connections.clear();
    fixture.plane.state.hostConnection.clear();
    fixture.mainCheckoutLeases.set("host-1#repository-1", "session-2");
    fixture.sessions.set("session-2", {
      id: "session-2",
      repositoryId: "repository-1",
      prompt: "test",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["cmd"],
      queueTtlSeconds: 3600,
      queueExpiresAt: "2026-08-13T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      type: "scheduled",
      source: "schedule",
      principalId: "system",
      hostId: "host-1",
      worktreeId: null,
      attemptId: "attempt-2",
      mainCheckoutLease: true,
      assignmentConnectionId: "gateway-1",
    });

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "session:status",
          sessionId: "session-2",
          worktreeId: null,
          attemptId: "attempt-2",
          status: "completed",
          result: { summary: "done", summarySource: "harness" },
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
  });

  it("delivers session:status-acknowledged on the current connection even if this container's hostConnection cache missed it", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    // Simulates a warm Lambda container that never processed this host's
    // host:register (e.g. a different container handled it, or this one
    // just cold-started): the connection is durably authenticated, but the
    // in-process hostId->connectionId cache postToHost relies on is empty.
    fixture.plane.state.hostConnection.delete("host-1");
    fixture.management.send.mockClear();
    fixture.mainCheckoutLeases.set("host-1#repository-1", "session-2");
    fixture.sessions.set("session-2", {
      id: "session-2",
      repositoryId: "repository-1",
      prompt: "test",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["cmd"],
      queueTtlSeconds: 3600,
      queueExpiresAt: "2026-08-13T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      type: "scheduled",
      source: "schedule",
      principalId: "system",
      hostId: "host-1",
      worktreeId: null,
      attemptId: "attempt-2",
      mainCheckoutLease: true,
      assignmentConnectionId: "gateway-1",
    });

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "session:status",
          sessionId: "session-2",
          worktreeId: null,
          attemptId: "attempt-2",
          status: "completed",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(
      fixture.management.send.mock.calls.map((call) => JSON.parse(String(call[0].input.Data))),
    ).toContainEqual({
      type: "session:status-acknowledged",
      sessionId: "session-2",
      attemptId: "attempt-2",
    });
  });

  it("rejects unauthenticated sockets and cleans pending or registered disconnects", async () => {
    const denied = runtimeFixture(null);
    await expect(
      (await denied.runtime).websocket({
        requestContext: { connectionId: "denied", routeKey: "$connect" },
      }),
    ).resolves.toEqual({ statusCode: 403 });

    const fixture = runtimeFixture();
    const runtime = await fixture.runtime;
    process.env.HARNESS_METRIC_ENVIRONMENT = "test";
    const metricLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runtime.websocket({
          requestContext: { connectionId: "missing", routeKey: "$default" },
        }),
      ).resolves.toEqual({ statusCode: 401 });
      // Every deployed-path discard reason is counted the same way the local
      // ws-hub bridge counts its own — this is the one the Lambda ingress
      // hits for a connectionId with no authenticated row.
      expect(
        metricLog.mock.calls.some(([line]) => String(line).includes('"WsMessagesDiscarded":1')),
      ).toBe(true);
    } finally {
      delete process.env.HARNESS_METRIC_ENVIRONMENT;
      metricLog.mockRestore();
    }
    // A frame for a connectionId with no authenticated row (its lease was
    // released, e.g. by the stale-heartbeat sweeper) must force-close the
    // physical socket — otherwise a daemon whose lease is gone has no way to
    // learn that and never reconnects.
    expect(
      fixture.management.send.mock.calls.some(
        (call) =>
          call[0] instanceof DeleteConnectionCommand && call[0].input.ConnectionId === "missing",
      ),
    ).toBe(true);
    await runtime.websocket({
      requestContext: { connectionId: "pending", routeKey: "$connect" },
    });
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "pending", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.deletedConnections).toContain("pending");
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "missing", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
  });

  it("swallows a failed force-close instead of surfacing it to the caller", async () => {
    // A connectionId with no authenticated row is already gone from this
    // API's perspective, so a failure closing its (possibly already-dead)
    // physical socket must never fail the frame's own rejection response.
    const fixture = runtimeFixture();
    const runtime = await fixture.runtime;
    fixture.management.send.mockRejectedValueOnce(new Error("management unavailable"));
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "missing", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 401 });
  });

  it("awaits the force-close before completing the invocation", async () => {
    // Lambda may freeze the execution environment as soon as the handler's
    // returned promise settles, so the DeleteConnectionCommand must be
    // tracked through the same deliveries mechanism as postToHost — an
    // untracked background send is not guaranteed to ever run.
    const fixture = runtimeFixture();
    const runtime = await fixture.runtime;
    let release: (() => void) | undefined;
    fixture.management.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    let settled = false;
    const rejection = runtime
      .websocket({
        requestContext: { connectionId: "missing", routeKey: "$default" },
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release!();
    await expect(rejection).resolves.toEqual({ statusCode: 401 });
    expect(fixture.management.send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteConnectionCommand);
  });

  it("lazily creates one shared runtime for all exported handler shapes", async () => {
    const cron = vi.fn(async () => ({
      ackDeadlinesEnforced: 0,
      archivesRetried: 0,
      queuedAssigned: 0,
      scheduledAssigned: 0,
      schedulesFired: 0,
      staleHostsReclaimed: 0,
    }));
    const rest = vi.fn(async () => ({ statusCode: 204 }));
    const websocket = vi.fn(async () => ({ statusCode: 200 }));
    const create = vi.fn(async () => ({ cron, rest, websocket }));
    const handlers = createLambdaHandlers(create);

    await expect(handlers.cron()).resolves.toMatchObject({ schedulesFired: 0 });
    await expect(handlers.rest({})).resolves.toEqual({ statusCode: 204 });
    await expect(
      handlers.websocket({
        requestContext: { connectionId: "one", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("forwards the real AWS cron context instead of treating the event as context", async () => {
    const cron = vi.fn(async () => ({
      ackDeadlinesEnforced: 0,
      archivesRetried: 0,
      queuedAssigned: 0,
      scheduledAssigned: 0,
      schedulesFired: 0,
      staleHostsReclaimed: 0,
    }));
    const handlers = createLambdaHandlers(async () => ({
      cron,
      rest: vi.fn(async () => ({ statusCode: 204 })),
      websocket: vi.fn(async () => ({ statusCode: 200 })),
    }));
    const event = { source: "aws.events" };
    const context = { getRemainingTimeInMillis: () => 9_000 };
    await handlers.cron(event, context);
    expect(cron).toHaveBeenCalledWith(event, context);
  });

  it("retries construction on the next invocation instead of caching a failed cold start", async () => {
    // A rejected promise is not null/undefined, so a bare `runtime ??= createRuntime()`
    // would cache the failure forever — every invocation this container ever handles
    // again would reject immediately, e.g. because an SSM bootstrap-secret parameter was
    // not yet provisioned at the container's first cold start.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("SSM parameter not found"))
      .mockResolvedValueOnce({
        cron: vi.fn(async () => ({
          ackDeadlinesEnforced: 0,
          archivesRetried: 0,
          queuedAssigned: 0,
          scheduledAssigned: 0,
          schedulesFired: 0,
          staleHostsReclaimed: 0,
        })),
        rest: vi.fn(),
        websocket: vi.fn(),
      });
    const handlers = createLambdaHandlers(create);

    await expect(handlers.cron()).rejects.toThrow("SSM parameter not found");
    await expect(handlers.cron()).resolves.toMatchObject({ schedulesFired: 0 });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries after a Slack SSM access failure instead of treating it as optional absence", async () => {
    const previousParam = process.env.HARNESS_SLACK_APP_SSM_PARAM;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.env.HARNESS_SLACK_APP_SSM_PARAM = "/slack/app";
      const failure = Object.assign(new Error("KMS decryption denied"), {
        name: "AccessDeniedException",
      });
      const ssm = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ Parameter: {} });
      const create = vi.fn(async () => {
        await loadSlackAppCredentials({ send: ssm } as never);
        return {
          cron: vi.fn(async () => ({
            ackDeadlinesEnforced: 0,
            archivesRetried: 0,
            cancelsRedelivered: 0,
            queuedAssigned: 0,
            repositoriesReconciled: 0,
            runningTimeoutsEnforced: 0,
            scheduledAssigned: 0,
            schedulesFired: 0,
            sessionDrainsReconciled: 0,
            staleHostsReclaimed: 0,
          })),
          rest: vi.fn(async () => ({ statusCode: 204 })),
          websocket: vi.fn(async () => ({ statusCode: 200 })),
        };
      });
      const handlers = createLambdaHandlers(create);

      await expect(handlers.rest({})).resolves.toMatchObject({ statusCode: 500 });
      await expect(handlers.rest({})).resolves.toEqual({ statusCode: 204 });
      expect(create).toHaveBeenCalledTimes(2);
      expect(ssm).toHaveBeenCalledTimes(2);
    } finally {
      if (previousParam === undefined) delete process.env.HARNESS_SLACK_APP_SSM_PARAM;
      else process.env.HARNESS_SLACK_APP_SSM_PARAM = previousParam;
      error.mockRestore();
    }
  });

  it("returns a structured REST 500 when cold-start construction throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createLambdaHandlers(async () => {
      throw new Error("SSM parameter not found");
    });

    await expect(
      handlers.rest({
        rawPath: "/api/v1/hosts/host-1/inventory",
        requestContext: { http: { method: "GET" } },
      }),
    ).resolves.toEqual({
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "internal server error" },
      }),
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("SSM parameter not found"));
    error.mockRestore();
  });

  it("does not duplicate successful REST requests in function logs", async () => {
    const fixture = runtimeFixture();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        (await fixture.runtime).rest({
          rawPath: "/missing",
          requestContext: { http: { method: "GET" } },
        }),
      ).resolves.toMatchObject({ statusCode: 404 });
      expect(
        consoleLog.mock.calls.some(([line]) => /"msg":"rest (?:start|success)"/.test(String(line))),
      ).toBe(false);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("returns a structured REST 500 when request handling throws", async () => {
    const fixture = runtimeFixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      (await fixture.runtime).rest({
        get rawPath() {
          throw new Error("adapter failed");
        },
      } as never),
    ).resolves.toEqual({
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "internal server error" },
      }),
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("adapter failed"));
    error.mockRestore();
  });

  it("returns a generic REST 500 when construction throws a non-Error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createLambdaHandlers(async () => {
      throw "bootstrap unavailable";
    });
    await expect(handlers.rest({})).resolves.toEqual({
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "internal server error" },
      }),
    });
    error.mockRestore();
  });

  it("reports REST, cron, and websocket failures to Sentry when a DSN is configured", async () => {
    const captured: unknown[] = [];
    const sentry: SentryClient = {
      captureException: (error, hint) => {
        captured.push({ error, hint });
      },
      flush: vi.fn(async () => true),
      init: vi.fn(),
    };
    resetApiSentryForTests(sentry);
    vi.stubEnv("HARNESS_API_SENTRY_DSN", "https://abc123@o1.ingest.sentry.io/450");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const handlers = createLambdaHandlers(async () => {
        throw new Error("bootstrap failed");
      });
      await expect(
        handlers.rest({ rawPath: "/x", requestContext: { http: { method: "GET" } } }),
      ).resolves.toMatchObject({ statusCode: 500 });
      await expect(handlers.cron()).rejects.toThrow("bootstrap failed");
      await expect(
        handlers.websocket({ requestContext: { connectionId: "c1", routeKey: "$default" } }),
      ).rejects.toThrow("bootstrap failed");
      expect(captured).toEqual([
        { error: expect.any(Error), hint: { tags: { runtime: "rest" } } },
        { error: expect.any(Error), hint: { tags: { runtime: "cron" } } },
        { error: expect.any(Error), hint: { tags: { runtime: "websocket" } } },
      ]);
      expect(sentry.flush).toHaveBeenCalledTimes(3);
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
      resetApiSentryForTests();
    }
  });

  it("hydrates catalogs unless HARNESS_HYDRATE_CATALOGS is false", () => {
    expect(lambdaHydrateCatalogsEnabled(undefined)).toBe(true);
    expect(lambdaHydrateCatalogsEnabled("true")).toBe(true);
    expect(lambdaHydrateCatalogsEnabled("false")).toBe(false);
  });

  it("does not retry a second concurrent caller of the same failed attempt", async () => {
    let reject!: (error: Error) => void;
    const create = vi.fn(() => new Promise<LambdaRuntime>((_resolve, r) => (reject = r)));
    const handlers = createLambdaHandlers(create);

    const first = handlers.cron();
    const second = handlers.cron();
    reject(new Error("SSM parameter not found"));

    await expect(first).rejects.toThrow("SSM parameter not found");
    await expect(second).rejects.toThrow("SSM parameter not found");
    // Both callers shared the one in-flight attempt; construction still only ran once
    // for this failure, and the *next* invocation after both have settled is what
    // triggers the retry (covered above), not each concurrent caller individually.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("runs a complete durable scheduler sweep and reports its work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-12T00:00:00.000Z");
    try {
      const fixture = runtimeFixture();
      seedSchedulerSweep(fixture);
      await expect((await fixture.runtime).cron()).resolves.toEqual({
        ackDeadlinesEnforced: 1,
        archivesRetried: 0,
        cancelsRedelivered: 0,
        runningTimeoutsEnforced: 1,
        queuedAssigned: 0,
        repositoriesReconciled: 1,
        sessionDrainsReconciled: 1,
        scheduledAssigned: 1,
        schedulesFired: 1,
        staleHostsReclaimed: 1,
      });
      expect(fixture.schedulerCalls).toEqual([
        "migration",
        "schedules",
        "sessions",
        "connections",
        "repositories",
        "running:0",
        "running:1",
        "running:2",
        "running:3",
        "sessions",
        "running:0",
        "running:1",
        "running:2",
        "running:3",
        "connections",
        "repositories",
        "running:0",
        "running:1",
        "running:2",
        "running:3",
        "stale-release",
        "repositories",
        "sessions",
        "sessions",
        "session-drains",
        "connections",
        "repositories",
        "running:0",
        "running:1",
        "running:2",
        "running:3",
      ]);
      // The reclaimed host's physical connection must be force-closed, not just
      // dropped from durable state — otherwise its daemon keeps an open,
      // unregistered socket forever with no signal telling it to reconnect.
      const deleteCalls = fixture.management.send.mock.calls.filter(
        (call) => call[0].input.ConnectionId === "stale-connection" && !("Data" in call[0].input),
      );
      expect(deleteCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a bounded assignment sweep for enqueue events without the repair cron", async () => {
    const fixture = runtimeFixture();
    seedSchedulerSweep(fixture);
    await expect((await fixture.runtime).cron({ source: "enqueue" })).resolves.toMatchObject({
      ackDeadlinesEnforced: 0,
      schedulesFired: 0,
      staleHostsReclaimed: 0,
    });
    expect(fixture.schedulerCalls).not.toContain("migration");
  });

  it("handles both closeReclaimedConnection outcomes without failing the sweep", async () => {
    // GoneException: the daemon already reconnected (or API Gateway already
    // dropped the socket) by the time the sweep gets around to closing it —
    // nothing left to close, and nothing worth logging either. Any other
    // error: best-effort, so it's logged but the sweep still reports success.
    for (const [thrown, expectLogged] of [
      [{ name: "GoneException" }, false],
      [new Error("boom"), true],
    ] as const) {
      vi.useFakeTimers();
      vi.setSystemTime("2026-08-12T00:00:00.000Z");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const fixture = runtimeFixture();
        seedSchedulerSweep(fixture);
        fixture.management.send.mockImplementation(
          async (command: { input: { ConnectionId?: string; Data?: unknown } }) => {
            if (command.input.ConnectionId === "stale-connection" && !("Data" in command.input)) {
              throw thrown;
            }
            return {};
          },
        );
        await expect((await fixture.runtime).cron()).resolves.toMatchObject({
          staleHostsReclaimed: 1,
        });
        if (expectLogged) {
          expect(consoleError).toHaveBeenCalledWith(
            JSON.stringify({
              msg: "closeReclaimedConnection failure",
              hostId: "stale-host",
              connectionId: "stale-connection",
              error: "boom",
            }),
          );
        } else {
          expect(consoleError).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
        consoleError.mockRestore();
      }
    }
  });

  it("drains Slack deliveries from cron and reports worker errors", async () => {
    const runOnce = vi.fn(async () => true);
    const spy = vi
      .spyOn(slackRuntime, "createSlackLifecycleWorker")
      .mockImplementation((_plane, options) => {
        options.worker?.onError?.(new Error("slack down"));
        return { runOnce } as never;
      });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await (await runtimeFixture().runtime).cron();
      expect(runOnce).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith("slack delivery failed", expect.any(Error));
    } finally {
      spy.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("stops archive retry work when Lambda time is reserved for Slack and metrics", async () => {
    const fixture = runtimeFixture();
    const retry = vi.spyOn(fixture.plane, "retryPendingArchivesDurable");
    await (await fixture.runtime).cron({ getRemainingTimeInMillis: () => 9_000 });
    expect(retry).toHaveBeenCalledWith(25, expect.any(Function));
    expect(retry.mock.calls[0]?.[1]?.()).toBe(false);
  });

  it("keeps retrying archives when the cron context omits a remaining-time budget", async () => {
    const fixture = runtimeFixture();
    const retry = vi.spyOn(fixture.plane, "retryPendingArchivesDurable");
    const redeliver = vi.spyOn(fixture.plane, "redeliverPendingCancelsDurable");
    await (await fixture.runtime).cron();
    expect(retry.mock.calls[0]?.[1]?.()).toBe(true);
    expect(redeliver.mock.calls[0]?.[1]?.()).toBe(true);
  });

  it("logs a non-Error closeReclaimedConnection failure without failing the sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-12T00:00:00.000Z");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fixture = runtimeFixture();
      seedSchedulerSweep(fixture);
      fixture.management.send.mockImplementation(
        async (command: { input: { ConnectionId?: string; Data?: unknown } }) => {
          if (command.input.ConnectionId === "stale-connection" && !("Data" in command.input)) {
            throw "raw-close-failure";
          }
          return {};
        },
      );
      await expect((await fixture.runtime).cron()).resolves.toMatchObject({
        staleHostsReclaimed: 1,
      });
      expect(consoleError).toHaveBeenCalledWith(
        JSON.stringify({
          msg: "closeReclaimedConnection failure",
          hostId: "stale-host",
          connectionId: "stale-connection",
          error: "raw-close-failure",
        }),
      );
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it("posts through the management API and prunes gone connections", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.management.send.mockClear();

    fixture.plane.drainHost("host-1");
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledTimes(1));
    fixture.management.send.mockRejectedValueOnce({ name: "GoneException" });
    fixture.plane.drainHost("host-1");
    await vi.waitFor(() => expect(fixture.plane.getHostConnectionId("host-1")).toBeUndefined());
    fixture.plane.drainHost("missing");

    await runtime.websocket({
      requestContext: { connectionId: "gateway-2", routeKey: "$connect" },
    });
    await runtime.websocket({
      body: JSON.stringify({
        type: "host:register",
        hostId: "host-1",
        worktrees: [],
        commandProfiles: [],
      }),
      requestContext: { connectionId: "gateway-2", routeKey: "$default" },
    });
    fixture.management.send.mockClear();
    const error = new Error("management unavailable");
    fixture.management.send.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fixture.plane.drainHost("host-1");
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('"msg":"postToHost failure"'),
    );
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("management unavailable"));
    consoleError.mockRestore();
  });

  it("counts only failed session assignments as assignment failures", async () => {
    const fixture = runtimeFixture();
    await registerGatewayHost(fixture);
    fixture.management.send.mockRejectedValue(new Error("management unavailable"));
    process.env.HARNESS_METRIC_ENVIRONMENT = "test";
    const metricLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const assignment = {
      type: "session:assign" as const,
      sessionId: "session-1",
      repositoryId: "repo-1",
      prompt: "run",
      resolvedArgv: [],
      timeout: 30,
      worktreeId: "worktree-1",
      assignedAt: "2026-08-12T00:00:00.000Z",
      attemptId: "attempt-1",
    };
    try {
      fixture.plane.state.onHostMessage?.("host-1", { type: "host:drain" });
      fixture.plane.state.onHostMessage?.("host-1", assignment);
      // Each failed delivery emits one structured failure log; the best-effort
      // delivery catch must not duplicate it with a generic second line.
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(2));
      const assignmentMetrics = metricLog.mock.calls.filter(([line]) =>
        String(line).includes('"AssignmentFailures":1'),
      );
      expect(assignmentMetrics).toHaveLength(1);
    } finally {
      delete process.env.HARNESS_METRIC_ENVIRONMENT;
      metricLog.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("runs assignment inline when ASSIGNMENT_FUNCTION_NAME is unset", async () => {
    const fixture = runtimeFixture();
    const request = vi.spyOn(fixture.plane, "requestAssignment").mockResolvedValue(undefined);
    const previousFn = process.env.ASSIGNMENT_FUNCTION_NAME;
    const previousWs = process.env.WS_API_ENDPOINT;
    try {
      delete process.env.ASSIGNMENT_FUNCTION_NAME;
      process.env.WS_API_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/prod";
      await createLambdaRuntime({
        auth: fixture.auth as never,
        created: { plane: fixture.plane, storage: fixture.storage } as never,
        management: fixture.management,
      });
      await fixture.plane.enqueueAssignment();
      expect(request).toHaveBeenCalled();
    } finally {
      if (previousFn === undefined) delete process.env.ASSIGNMENT_FUNCTION_NAME;
      else process.env.ASSIGNMENT_FUNCTION_NAME = previousFn;
      if (previousWs === undefined) delete process.env.WS_API_ENDPOINT;
      else process.env.WS_API_ENDPOINT = previousWs;
    }
  });

  it("wires explicit Slack app and identity clients into an existing Lambda plane", async () => {
    const fixture = runtimeFixture();
    const slackOAuthClient = {
      exchangeCode: vi.fn(),
      revokeBotToken: vi.fn(),
    } as never;
    const slackIdentityClient = { authTestBotToken: vi.fn() } as never;
    await createLambdaRuntime({
      auth: fixture.auth as never,
      created: { plane: fixture.plane, storage: fixture.storage } as never,
      management: fixture.management,
      slackAppCredentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
        signingSecret: "signing-secret",
      },
      slackOAuthClient,
      slackIdentityClient,
    });

    expect(fixture.plane.state.slackOAuthClient).toBe(slackOAuthClient);
    expect(fixture.plane.state.slackIdentityClient).toBe(slackIdentityClient);
    expect(fixture.plane.state.slackInboundEnabled).toBe(true);
  });

  it("bounds deployed assignment invocation requests", async () => {
    const fixture = runtimeFixture();
    const previousFunction = process.env.ASSIGNMENT_FUNCTION_NAME;
    const previousWs = process.env.WS_API_ENDPOINT;
    const send = vi.spyOn(LambdaClient.prototype, "send").mockResolvedValue({});
    try {
      process.env.ASSIGNMENT_FUNCTION_NAME = "assignment-function";
      process.env.WS_API_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/prod";
      await createLambdaRuntime({
        auth: fixture.auth as never,
        created: { plane: fixture.plane, storage: fixture.storage } as never,
        management: fixture.management,
      });
      await fixture.plane.enqueueAssignment();
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[1]).toMatchObject({
        abortSignal: expect.any(AbortSignal),
      });
    } finally {
      send.mockRestore();
      if (previousFunction === undefined) delete process.env.ASSIGNMENT_FUNCTION_NAME;
      else process.env.ASSIGNMENT_FUNCTION_NAME = previousFunction;
      if (previousWs === undefined) delete process.env.WS_API_ENDPOINT;
      else process.env.WS_API_ENDPOINT = previousWs;
    }
  });

  it("logs when enqueueing an assignment sweep fails", async () => {
    const fixture = runtimeFixture();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = process.env.WS_API_ENDPOINT;
    try {
      process.env.WS_API_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/prod";
      await createLambdaRuntime({
        auth: fixture.auth as never,
        created: { plane: fixture.plane, storage: fixture.storage } as never,
        management: fixture.management,
        invokeAssignment: async () => {
          throw new Error("enqueue failed");
        },
      });
      await fixture.plane.enqueueAssignment();
      expect(consoleError).toHaveBeenCalledWith(
        "failed to enqueue assignment sweep",
        expect.any(Error),
      );
    } finally {
      if (previous === undefined) delete process.env.WS_API_ENDPOINT;
      else process.env.WS_API_ENDPOINT = previous;
      consoleError.mockRestore();
    }
  });

  it("requires the management endpoint only when constructing its AWS client", async () => {
    const fixture = runtimeFixture();
    const previous = process.env.WS_API_ENDPOINT;
    try {
      delete process.env.WS_API_ENDPOINT;
      await expect(
        createLambdaRuntime({
          auth: fixture.auth as never,
          created: { plane: fixture.plane, storage: fixture.storage } as never,
        }),
      ).rejects.toThrow("WS_API_ENDPOINT is required");
      process.env.WS_API_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/prod";
      await expect(
        createLambdaRuntime({
          auth: fixture.auth as never,
          created: { plane: fixture.plane, storage: fixture.storage } as never,
        }),
      ).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.WS_API_ENDPOINT;
      else process.env.WS_API_ENDPOINT = previous;
    }
  });
});

/**
 * The plaintext env vars this replaced never touched an SDK client at all — they were
 * just process.env reads. Now that the three bootstrap secrets come from SSM, this is
 * the boundary where a wrong parameter name, a missing value, or a missing env var
 * should fail loudly rather than silently constructing an AuthService with an empty
 * secret.
 */
describe("loadBootstrapSecrets", () => {
  const names = [
    "HARNESS_ADMINS_SSM_PARAM",
    "HARNESS_SESSION_SECRET_SSM_PARAM",
    "HARNESS_CURSOR_SECRET_SSM_PARAM",
  ] as const;

  function withEnv<T>(values: Partial<Record<(typeof names)[number], string>>, run: () => T): T {
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) {
        if (values[name] === undefined) delete process.env[name];
        else process.env[name] = values[name];
      }
      return run();
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  }

  it("fetches all three parameters by name, decrypted, and returns the fetched values", async () => {
    const requests: string[] = [];
    const client = {
      send: vi.fn(async (command: { input: { Name: string; WithDecryption: boolean } }) => {
        requests.push(command.input.Name);
        expect(command.input.WithDecryption).toBe(true);
        return { Parameter: { Value: `value-for-${command.input.Name}` } };
      }),
    };

    const secrets = await withEnv(
      {
        HARNESS_ADMINS_SSM_PARAM: "/auto-harness/admins",
        HARNESS_SESSION_SECRET_SSM_PARAM: "/auto-harness/session-secret",
        HARNESS_CURSOR_SECRET_SSM_PARAM: "/auto-harness/cursor-secret",
      },
      () => loadBootstrapSecrets(client as never),
    );

    expect(secrets).toEqual({
      admins: "value-for-/auto-harness/admins",
      sessionSecret: "value-for-/auto-harness/session-secret",
      cursorSecret: "value-for-/auto-harness/cursor-secret",
    });
    expect(requests.toSorted()).toEqual([
      "/auto-harness/admins",
      "/auto-harness/cursor-secret",
      "/auto-harness/session-secret",
    ]);
  });

  it("fails loudly when a parameter name is not configured", async () => {
    const client = { send: vi.fn() };

    await expect(
      withEnv(
        {
          HARNESS_SESSION_SECRET_SSM_PARAM: "/auto-harness/session-secret",
          HARNESS_CURSOR_SECRET_SSM_PARAM: "/auto-harness/cursor-secret",
        },
        () => loadBootstrapSecrets(client as never),
      ),
    ).rejects.toThrow("HARNESS_ADMINS_SSM_PARAM is required in the Lambda runtime");
  });

  it("fails loudly when SSM returns no value for a parameter", async () => {
    const client = { send: vi.fn(async () => ({ Parameter: {} })) };

    await expect(
      withEnv(
        {
          HARNESS_ADMINS_SSM_PARAM: "/auto-harness/admins",
          HARNESS_SESSION_SECRET_SSM_PARAM: "/auto-harness/session-secret",
          HARNESS_CURSOR_SECRET_SSM_PARAM: "/auto-harness/cursor-secret",
        },
        () => loadBootstrapSecrets(client as never),
      ),
    ).rejects.toThrow("SSM parameter /auto-harness/admins has no value");
  });

  it("constructs the default SSM client when none is injected", async () => {
    const send = vi.spyOn(SSMClient.prototype, "send").mockImplementation(async (command) => {
      const name = (command as { input: { Name: string } }).input.Name;
      return { Parameter: { Value: `value-for-${name}` } } as never;
    });
    try {
      const secrets = await withEnv(
        {
          HARNESS_ADMINS_SSM_PARAM: "/auto-harness/admins",
          HARNESS_SESSION_SECRET_SSM_PARAM: "/auto-harness/session-secret",
          HARNESS_CURSOR_SECRET_SSM_PARAM: "/auto-harness/cursor-secret",
        },
        () => loadBootstrapSecrets(),
      );
      expect(secrets.admins).toBe("value-for-/auto-harness/admins");
      expect(send).toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });
});

/**
 * Unlike loadBootstrapSecrets, a missing name, a missing value, and a failed SSM call
 * all fall back to undefined here so the Lambda cold start still succeeds. Session
 * `url` fields and Slack deep links then use ControlPlane's localhost default.
 * Viewer WebSocket Origin checks stay fail-closed until a later connect can read
 * the published URL.
 */
function withPublicBaseUrlParamEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.PUBLIC_BASE_URL_SSM_PARAM;
  try {
    if (value === undefined) delete process.env.PUBLIC_BASE_URL_SSM_PARAM;
    else process.env.PUBLIC_BASE_URL_SSM_PARAM = value;
    return run();
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_BASE_URL_SSM_PARAM;
    else process.env.PUBLIC_BASE_URL_SSM_PARAM = previous;
  }
}

describe("loadSlackAppCredentials", () => {
  it("uses local JSON before optional SSM and treats missing/malformed values as unavailable", async () => {
    const previousLocal = process.env.HARNESS_SLACK_APP;
    const previousParam = process.env.HARNESS_SLACK_APP_SSM_PARAM;
    try {
      process.env.HARNESS_SLACK_APP = JSON.stringify({
        clientId: "local",
        clientSecret: "secret",
        signingSecret: "slack-signing_secret-123",
      });
      process.env.HARNESS_SLACK_APP_SSM_PARAM = "/slack/app";
      const client = { send: vi.fn() };
      await expect(loadSlackAppCredentials(client as never)).resolves.toMatchObject({
        clientId: "local",
      });
      expect(client.send).not.toHaveBeenCalled();
      delete process.env.HARNESS_SLACK_APP;
      const ssm = {
        send: vi.fn(async () => ({
          Parameter: {
            Value: JSON.stringify({
              clientId: "ssm",
              clientSecret: "secret",
              signingSecret: "slack-signing_secret-123",
            }),
          },
        })),
      };
      await expect(loadSlackAppCredentials(ssm as never)).resolves.toMatchObject({
        clientId: "ssm",
      });
      await expect(
        loadSlackAppCredentials({ send: async () => ({ Parameter: {} }) } as never),
      ).resolves.toBeUndefined();
      await expect(
        loadSlackAppCredentials({
          send: async () => ({ Parameter: { Value: "not JSON" } }),
        } as never),
      ).resolves.toBeUndefined();
      delete process.env.HARNESS_SLACK_APP_SSM_PARAM;
      await expect(loadSlackAppCredentials(client as never)).resolves.toBeUndefined();
    } finally {
      if (previousLocal === undefined) delete process.env.HARNESS_SLACK_APP;
      else process.env.HARNESS_SLACK_APP = previousLocal;
      if (previousParam === undefined) delete process.env.HARNESS_SLACK_APP_SSM_PARAM;
      else process.env.HARNESS_SLACK_APP_SSM_PARAM = previousParam;
    }
  });

  it("treats the AWS SSM ParameterNotFound exception as optional absence", async () => {
    const previousParam = process.env.HARNESS_SLACK_APP_SSM_PARAM;
    try {
      process.env.HARNESS_SLACK_APP_SSM_PARAM = "/slack/app";
      const absent = new ParameterNotFound({ message: "optional Slack app is not provisioned" });
      await expect(
        loadSlackAppCredentials({ send: async () => Promise.reject(absent) } as never),
      ).resolves.toBeUndefined();
    } finally {
      if (previousParam === undefined) delete process.env.HARNESS_SLACK_APP_SSM_PARAM;
      else process.env.HARNESS_SLACK_APP_SSM_PARAM = previousParam;
    }
  });

  it("rejects SSM, KMS, access, and lookalike errors so the Lambda handler retries construction", async () => {
    const previousParam = process.env.HARNESS_SLACK_APP_SSM_PARAM;
    try {
      process.env.HARNESS_SLACK_APP_SSM_PARAM = "/slack/app";
      const failures = [
        new Error("SSM temporarily unavailable"),
        Object.assign(new Error("KMS decryption denied"), { name: "AccessDeniedException" }),
        Object.assign(new Error("not an AWS SDK exception"), { name: "ParameterNotFound" }),
      ];
      for (const failure of failures) {
        await expect(
          loadSlackAppCredentials({ send: async () => Promise.reject(failure) } as never),
        ).rejects.toBe(failure);
      }
    } finally {
      if (previousParam === undefined) delete process.env.HARNESS_SLACK_APP_SSM_PARAM;
      else process.env.HARNESS_SLACK_APP_SSM_PARAM = previousParam;
    }
  });
});

describe("fetchPublicBaseUrl", () => {
  it("fetches the published URL by name, without decryption", async () => {
    const client = {
      send: vi.fn(async (command: { input: { Name: string; WithDecryption?: boolean } }) => {
        expect(command.input.Name).toBe("/auto-harness/qa/public-base-url");
        expect(command.input.WithDecryption).toBeUndefined();
        return { Parameter: { Value: "https://d1234.cloudfront.net" } };
      }),
    };

    const url = await withPublicBaseUrlParamEnv("/auto-harness/qa/public-base-url", () =>
      fetchPublicBaseUrl(client as never),
    );

    expect(url).toBe("https://d1234.cloudfront.net");
  });

  it("returns undefined when the parameter name is not configured", async () => {
    const client = { send: vi.fn() };

    const url = await withPublicBaseUrlParamEnv(undefined, () =>
      fetchPublicBaseUrl(client as never),
    );

    expect(url).toBeUndefined();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("returns undefined when SSM has no value, or the call fails", async () => {
    const noValue = { send: vi.fn(async () => ({ Parameter: {} })) };
    await expect(
      withPublicBaseUrlParamEnv("/auto-harness/qa/public-base-url", () =>
        fetchPublicBaseUrl(noValue as never),
      ),
    ).resolves.toBeUndefined();

    const failing = { send: vi.fn(async () => Promise.reject(new Error("ParameterNotFound"))) };
    await expect(
      withPublicBaseUrlParamEnv("/auto-harness/qa/public-base-url", () =>
        fetchPublicBaseUrl(failing as never),
      ),
    ).resolves.toBeUndefined();
  });

  it("constructs the default SSM client when fetching the public base URL", async () => {
    const send = vi.spyOn(SSMClient.prototype, "send").mockResolvedValue({
      Parameter: { Value: "https://d1234.cloudfront.net" },
    } as never);
    try {
      await expect(
        withPublicBaseUrlParamEnv("/auto-harness/qa/public-base-url", () => fetchPublicBaseUrl()),
      ).resolves.toBe("https://d1234.cloudfront.net");
      expect(send).toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });
});
