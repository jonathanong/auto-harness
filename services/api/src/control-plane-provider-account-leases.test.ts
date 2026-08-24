/* eslint-disable max-lines -- assignment, hydrate, and helper cases share one fixture. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { backfillLegacyProviderAccountLeases } from "./control-plane-hydrate-provider-leases.ts";
import {
  accountHasLeaseCapacity,
  accountHasLeaseCapacityOverCap,
  accountHasLeaseCapacityFromReadModel,
  hostHasAssignmentCapacity,
  hostAssignmentOccupancyCount,
  hostProviderAccountReady,
  sessionOccupiesHostAssignment,
  maxConcurrentSessionsFor,
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
  releaseProviderAccountLeaseForSession,
  releaseProviderAccountLeaseLocal,
  tryAcquireProviderAccountLeaseLocal,
} from "./control-plane-provider-account-leases.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const FINGERPRINT = "a".repeat(64);
const NOW = "2026-01-01T00:00:00.000Z";

function seedAccountPlane(opts?: { maxConcurrentSessions?: number; ready?: boolean }) {
  let n = 0;
  const plane = new ControlPlane({
    now: () => NOW,
    idFactory: () => `sess-${++n}`,
    attemptIdFactory: () => `attempt-${n}`,
    connectionIdFactory: () => "conn-1",
    shardCount: 1,
    heartbeatStaleMs: 1,
  });
  expect(plane.createProvider({ id: "prov-1", name: "claude" }).ok).toBe(true);
  expect(
    plane.createCommand({
      id: "cmd-1",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
    }).ok,
  ).toBe(true);
  expect(plane.updateProvider("prov-1", { defaultCommandId: "cmd-1" }).ok).toBe(true);
  expect(
    plane.createProviderAccount({
      id: "acct-1",
      providerId: "prov-1",
      label: "one",
      ...(opts?.maxConcurrentSessions !== undefined
        ? { maxConcurrentSessions: opts.maxConcurrentSessions }
        : {}),
    }).ok,
  ).toBe(true);
  expect(
    plane.putHostInventory("host-1", {
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [
            { id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] },
            { id: "wt-2", name: "wt-2", path: "/repo/wt-2", labels: [] },
          ],
        },
      ],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
    }).ok,
  ).toBe(true);
  expect(
    plane.registerHost({
      hostId: "host-1",
      worktrees: [
        { id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/repo/wt-1", labels: [] },
        { id: "wt-2", name: "wt-2", repositoryId: "repo-1", path: "/repo/wt-2", labels: [] },
      ],
      protocolVersion: 1,
      ...(opts?.ready === false
        ? {}
        : {
            providerAccountReadiness: [
              {
                providerAccountId: "acct-1",
                ready: opts?.ready !== false,
                fingerprint: FINGERPRINT,
              },
            ],
          }),
    }).ok,
  ).toBe(true);
  return plane;
}

describe("provider account execution-profile leases", () => {
  it("retries another slot after a concurrent legacy lease backfill", async () => {
    const sessions = ["a", "b"].map((id) => ({
      id,
      status: "running",
      hostId: "host",
      attemptId: `${id}-attempt`,
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "acct",
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: `${id}-attempt`,
      },
    })) as never[];
    sessions.push({
      id: "invalid",
      status: "running",
      hostId: "host",
      resolvedRoute: { providerAccountId: "acct", hostId: "host" },
    } as never);
    let calls = 0;
    await backfillLegacyProviderAccountLeases(
      {
        storage: {
          backfillProviderAccountLease: async (opts: { slot: number }) => {
            calls += 1;
            if (calls === 1) return { status: "lease_collision" };
            return {
              status: "migrated",
              lease: {
                concurrencyId: `provider-lease:acct:${String(opts.slot)}`,
                providerAccountId: "acct",
                slot: opts.slot,
                attemptId: "attempt",
              },
            };
          },
        },
      } as never,
      sessions,
    );
    expect(calls).toBe(3);
    expect(sessions[0]).toHaveProperty("providerAccountLease.slot", 1);
    expect(sessions[1]).toHaveProperty("providerAccountLease.slot", 2);
  });

  it("handles a legacy session fenced by another hydrator", async () => {
    const session = {
      id: "changed",
      status: "running",
      hostId: "host",
      attemptId: "attempt",
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "acct",
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
      },
    } as never;
    await backfillLegacyProviderAccountLeases(
      {
        storage: {
          backfillProviderAccountLease: async () => ({ status: "session_changed" }),
        },
      } as never,
      [session],
    );
    expect(session).not.toHaveProperty("providerAccountLease");
  });

  it("hydrates a lease observed after another hydrator wins", async () => {
    const lease = {
      concurrencyId: "provider-lease:acct:0",
      providerAccountId: "acct",
      slot: 0,
      attemptId: "attempt",
    };
    const session = {
      id: "changed",
      status: "running",
      hostId: "host",
      attemptId: "attempt",
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "acct",
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
      },
    } as never;
    await backfillLegacyProviderAccountLeases(
      {
        storage: {
          backfillProviderAccountLease: async () => ({ status: "session_changed" }),
          getSession: async () => ({ providerAccountLease: lease }),
        },
      } as never,
      [session],
    );
    expect(session.providerAccountLease).toEqual(lease);
  });

  it("fails closed when the exact account profile is not advertised as ready", () => {
    const plane = seedAccountPlane({ ready: false });
    const created = plane.createSession({
      repositoryId: "repo-1",
      prompt: "work",
      target: { providerId: "prov-1" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    expect(plane.assignQueued()).toEqual([]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
  });

  it("keeps legacy generic locks separate from provider-account leases", () => {
    const plane = seedAccountPlane({ maxConcurrentSessions: 1 });
    const created = plane.createSession({
      repositoryId: "repo-1",
      prompt: "legacy lock",
      target: { providerId: "prov-1" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    const queued = plane.state.sessions.get("sess-1")!;
    queued.concurrencyId = "provider-account:acct-1:0";

    expect(plane.assignQueued()).toHaveLength(1);
    expect(plane.getSession("sess-1")?.providerAccountLease?.concurrencyId).toBe(
      "provider-lease:acct-1:0",
    );
  });

  it("honors advertised host assignment capacity", () => {
    const plane = seedAccountPlane({ maxConcurrentSessions: 2 });
    const connectionId = plane.state.hostConnection.get("host-1")!;
    const conn = plane.state.connections.get(connectionId)!;
    plane.state.connections.set(connectionId, { ...conn, maxConcurrentAssignments: 1 });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "one",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "two",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    expect(plane.assignQueued()).toEqual([]);
  });

  it("seeds a missing durable host count from active legacy assignments", () => {
    const state = createControlPlaneState();
    state.sessions.set("legacy", {
      id: "legacy",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 60,
      queueExpiresAt: NOW,
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: NOW,
      hostId: "host",
      worktreeId: "worktree",
    });
    expect(hostAssignmentOccupancyCount(state, "host")).toBe(1);
    expect(hostAssignmentOccupancyCount(state, "other")).toBe(0);
  });

  it("exhausts account slots at maxConcurrentSessions", () => {
    const plane = seedAccountPlane({ maxConcurrentSessions: 1 });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "one",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "two",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    expect(plane.assignQueued()).toEqual([]);
    expect(plane.getSession("sess-1")?.status).toBe("running");
    expect(plane.getSession("sess-2")?.status).toBe("queued");
    expect(plane.getSession("sess-1")?.providerAccountLease?.slot).toBe(0);
  });

  it("blocks durable assignment while legacy leases occupy slots beyond the cap", () => {
    const state = createControlPlaneState();
    state.storage = {} as never;
    state.providerAccounts.set("acct", {
      id: "acct",
      providerId: "prov",
      label: "account",
      maxConcurrentSessions: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.providerAccountLeases.set("provider-lease:acct:1", {
      sessionId: "legacy",
      attemptId: "attempt",
      slot: 1,
      hostId: "host",
      providerAccountId: "acct",
    });
    expect(accountHasLeaseCapacityOverCap(state, "acct")).toBe(true);
    expect(accountHasLeaseCapacity(state, "acct")).toBe(false);
    state.providerAccountLeases.clear();
    expect(accountHasLeaseCapacity(state, "acct")).toBe(true);
  });

  it("does not count queued leftover lease fields as active capacity holders", () => {
    const state = createControlPlaneState();
    state.providerAccounts.set("acct", {
      id: "acct",
      providerId: "prov",
      label: "account",
      maxConcurrentSessions: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.sessions.set("queued", {
      id: "queued",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 1,
      queueExpiresAt: NOW,
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: NOW,
      providerAccountLease: {
        concurrencyId: "provider-lease:acct:0",
        providerAccountId: "acct",
        slot: 0,
        attemptId: "old",
      },
    });
    expect(accountHasLeaseCapacityFromReadModel(state, "acct")).toBe(true);
  });

  it("treats missing readiness as unavailable and honors host assignment caps", () => {
    const state = createControlPlaneState();
    expect(hostProviderAccountReady(state, "missing", "acct")).toBe(false);
    expect(hostProviderAccountReady(state, "missing", undefined)).toBe(true);
    expect(maxConcurrentSessionsFor(undefined)).toBe(1);
    expect(accountHasLeaseCapacity(state, undefined)).toBe(true);
    state.hostConnection.set("host", "conn");
    state.connections.set("conn", {
      connectionId: "conn",
      type: "host",
      hostId: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      maxConcurrentAssignments: 1,
      providerAccountReadiness: [
        { providerAccountId: "acct", ready: true, fingerprint: FINGERPRINT },
      ],
    });
    expect(hostProviderAccountReady(state, "host", "acct")).toBe(true);
    expect(hostProviderAccountReady(state, "host", "other")).toBe(false);
    expect(hostHasAssignmentCapacity(state, "host")).toBe(true);
    state.sessions.set("running", {
      id: "running",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "c" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 1,
      queueExpiresAt: NOW,
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: NOW,
      hostId: "host",
    });
    expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
    expect(hostHasAssignmentCapacity(state, "other")).toBe(true);
    state.storage = {} as never;
    expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
    const cancelled = {
      ...state.sessions.get("running")!,
      id: "cancelled",
      status: "cancelled" as const,
      worktreeId: "wt",
    };
    expect(sessionOccupiesHostAssignment(cancelled)).toBe(true);
    expect(sessionOccupiesHostAssignment({ ...cancelled, hostId: undefined })).toBe(false);
    expect(sessionOccupiesHostAssignment({ ...cancelled, worktreeId: null, hostId: "host" })).toBe(
      false,
    );
    state.sessions.clear();
    state.sessions.set("cancelled", cancelled);
    expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
    state.sessions.clear();
    state.worktrees.set("wt", {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "cancelled",
    });
    expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
    state.worktrees.clear();
    state.mainCheckoutLeases.set("host\0repo", { sessionId: "held", connectionId: "conn" });
    expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
  });

  it("releases a lease idempotently", async () => {
    const state = createControlPlaneState();
    const session = {
      id: "sess",
      attemptId: "attempt",
      providerAccountLease: {
        concurrencyId: "provider-lease:acct:0",
        providerAccountId: "acct",
        slot: 0,
        attemptId: "attempt",
      },
    };
    expect(
      tryAcquireProviderAccountLeaseLocal(state, session as never, "acct", "attempt", "host"),
    ).toEqual(session.providerAccountLease);
    expect(releaseProviderAccountLeaseLocal(state, session)).toBe(true);
    expect(releaseProviderAccountLeaseLocal(state, session)).toBe(false);
    expect(
      releaseProviderAccountLeaseLocal(state, { ...session, providerAccountLease: undefined }),
    ).toBe(false);
    expect(
      tryAcquireProviderAccountLeaseLocal(state, session as never, undefined, "attempt", "host"),
    ).toBeUndefined();
    expect(state.providerAccountLeases.size).toBe(0);
    expect(
      tryAcquireProviderAccountLeaseLocal(state, session as never, "acct", "attempt", "host"),
    ).toBeDefined();
    expect(
      tryAcquireProviderAccountLeaseLocal(state, session as never, "acct", "other", "host"),
    ).toBeUndefined();
    expect(accountHasLeaseCapacity(state, "acct")).toBe(false);
    expect(
      releaseProviderAccountLeaseLocal(state, {
        ...session,
        id: "other",
        providerAccountLease: session.providerAccountLease,
      }),
    ).toBe(false);
    const released = { id: "sess", providerAccountLease: undefined } as never;
    releaseProviderAccountLease(state, released);
    expect(releaseProviderAccountLeaseForSession(state, released as never)).toEqual(released);
    const queued: Array<{ concurrencyId: string; sessionId: string; attemptId: string }> = [];
    state.storage = {
      releaseProviderAccountLease: async (opts: {
        concurrencyId: string;
        sessionId: string;
        attemptId: string;
      }) => {
        queued.push(opts);
      },
    } as never;
    const held = {
      id: "sess",
      attemptId: "attempt",
      providerAccountLease: session.providerAccountLease,
    } as never;
    tryAcquireProviderAccountLeaseLocal(state, held, "acct", "attempt", "host");
    const next = releaseProviderAccountLeaseForSession(state, held);
    expect(next).not.toHaveProperty("providerAccountLease");
    await state.writeTail;
    expect(queued).toEqual([
      {
        concurrencyId: "provider-lease:acct:0",
        sessionId: "sess",
        attemptId: "attempt",
      },
    ]);
  });

  it("reconciles unacked leases when a host goes stale", () => {
    const plane = seedAccountPlane({ maxConcurrentSessions: 1 });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "one",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    expect(plane.state.providerAccountLeases.size).toBe(1);
    plane.heartbeat("host-1", NOW);
    expect(plane.reclaimStaleHosts(Date.parse(NOW) + 2)).toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    expect(plane.state.providerAccountLeases.size).toBe(0);
  });

  it("rebuilds in-memory leases from running sessions on hydrate", async () => {
    const plane = new ControlPlane();
    let backfilled: { sessionId: string; slot: number } | undefined;
    plane.state.storage = {
      listAllSessions: async () => [
        {
          id: "legacy",
          repositoryId: "repo",
          prompt: "p",
          target: { commandId: "c" },
          fallbacks: [],
          targetLabels: [],
          queueTtlSeconds: 1,
          queueExpiresAt: NOW,
          timeout: 1,
          priority: 0,
          requiredLabels: [],
          status: "running",
          queueShard: 0,
          createdAt: NOW,
          hostId: "host",
          attemptId: "legacy-attempt",
          resolvedRoute: {
            targetIndex: 0,
            providerId: "p",
            providerAccountId: "acct",
            commandId: "c",
            hostId: "host",
            worktreeId: null,
            attemptId: "legacy-attempt",
          },
        },
        {
          id: "running",
          repositoryId: "repo",
          prompt: "p",
          target: { commandId: "c" },
          fallbacks: [],
          targetLabels: [],
          queueTtlSeconds: 1,
          queueExpiresAt: NOW,
          timeout: 1,
          priority: 0,
          requiredLabels: [],
          status: "running",
          queueShard: 0,
          createdAt: NOW,
          hostId: "host",
          providerAccountLease: {
            concurrencyId: "provider-lease:acct:0",
            providerAccountId: "acct",
            slot: 0,
            attemptId: "attempt",
          },
        },
        {
          id: "queued",
          repositoryId: "repo",
          prompt: "p",
          target: { commandId: "c" },
          fallbacks: [],
          targetLabels: [],
          queueTtlSeconds: 1,
          queueExpiresAt: NOW,
          timeout: 1,
          priority: 0,
          requiredLabels: [],
          status: "queued",
          queueShard: 0,
          createdAt: NOW,
          providerAccountLease: {
            concurrencyId: "provider-lease:acct:1",
            providerAccountId: "acct",
            slot: 1,
            attemptId: "old",
          },
        },
        {
          id: "cancelled-released",
          repositoryId: "repo",
          prompt: "p",
          target: { commandId: "c" },
          fallbacks: [],
          targetLabels: [],
          queueTtlSeconds: 1,
          queueExpiresAt: NOW,
          timeout: 1,
          priority: 0,
          requiredLabels: [],
          status: "cancelled",
          queueShard: 0,
          createdAt: NOW,
          hostId: null,
          providerAccountLease: {
            concurrencyId: "provider-lease:acct:2",
            providerAccountId: "acct",
            slot: 2,
            attemptId: "done",
          },
        },
      ],
      listAllWorktrees: async () => [],
      listConnections: async () => [],
      listSchedules: async () => [],
      listRepositories: async () => [],
      listHostInventories: async () => [],
      listProviders: async () => [],
      listProviderAccounts: async () => [
        { id: "acct", providerId: "p", label: "a", createdAt: NOW, updatedAt: NOW },
      ],
      listCommands: async () => [],
      listArchives: async () => [],
      listAllAuditLogs: async () => [],
      listLogs: async () => [],
      backfillProviderAccountLease: async (opts: { sessionId: string; slot: number }) => {
        backfilled = opts;
        return {
          status: "migrated",
          lease: {
            concurrencyId: "provider-lease:acct:1",
            providerAccountId: "acct",
            slot: opts.slot,
            attemptId: "legacy-attempt",
          },
        };
      },
    } as never;
    await plane.hydrateFromStorage();
    expect(plane.state.providerAccountLeases.get("provider-lease:acct:0")).toMatchObject({
      sessionId: "running",
      attemptId: "attempt",
    });
    expect(plane.state.providerAccountLeases.has("provider-lease:acct:1")).toBe(true);
    expect(plane.state.providerAccountLeases.has("provider-lease:acct:2")).toBe(false);
    expect(backfilled).toMatchObject({ sessionId: "legacy", slot: 1 });
    expect(plane.getSession("legacy")?.providerAccountLease?.concurrencyId).toBe(
      "provider-lease:acct:1",
    );
    expect(plane.getProviderAccount("acct")?.maxConcurrentSessions).toBe(1);
  });

  it("retains the account lease until an acknowledged timeout reports terminal", () => {
    const plane = seedAccountPlane({ maxConcurrentSessions: 1 });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "one",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    const session = plane.getSession("sess-1")!;
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: session.id,
        worktreeId: session.worktreeId!,
        attemptId: session.attemptId!,
      }).ok,
    ).toBe(true);
    expect(plane.state.providerAccountLeases.size).toBe(1);
    const due = Date.parse(plane.getSession("sess-1")!.ackReceivedAt!) + 30_000;
    expect(plane.enforceRunningTimeouts(due)).toEqual(["sess-1"]);
    expect(plane.state.providerAccountLeases.size).toBe(1);
    expect(plane.getSession("sess-1")).toHaveProperty("providerAccountLease");
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "two",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(0);
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId: "sess-1",
        worktreeId: session.worktreeId!,
        attemptId: session.attemptId!,
        status: "completed",
      }).ok,
    ).toBe(true);
    expect(plane.state.providerAccountLeases.size).toBe(0);
    expect(plane.assignQueued()).toHaveLength(1);
  });

  it("retains a provider-account lease through durable timeout", async () => {
    const plane = seedAccountPlane({ maxConcurrentSessions: 1 });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "one",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    const session = plane.getSession("sess-1")!;
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: session.id,
        worktreeId: session.worktreeId!,
        attemptId: session.attemptId!,
      }).ok,
    ).toBe(true);
    const finished: unknown[] = [];
    plane.state.storage = {
      listAllSessions: async () => [plane.state.sessions.get("sess-1")!],
      finishSession: async (opts: unknown) => {
        finished.push(opts);
        return true;
      },
      listLogs: async () => [],
      putArchive: async () => undefined,
    } as never;
    const due = Date.parse(plane.getSession("sess-1")!.ackReceivedAt!) + 30_000;
    expect(await plane.enforceRunningTimeoutsDurable(due)).toEqual(["sess-1"]);
    expect(finished[0]).toMatchObject({
      sessionId: "sess-1",
      status: "timed_out",
      preserveProviderAccountLease: true,
    });
    expect(plane.state.providerAccountLeases.size).toBe(1);
  });

  it("counts a cancelled in-flight assignment against the advertised host cap", () => {
    const plane = seedAccountPlane({ maxConcurrentSessions: 2 });
    const connectionId = plane.state.hostConnection.get("host-1")!;
    const conn = plane.state.connections.get(connectionId)!;
    plane.state.connections.set(connectionId, { ...conn, maxConcurrentAssignments: 1 });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "one",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    expect(plane.cancelSession("sess-1").ok).toBe(true);
    expect(plane.getSession("sess-1")).toMatchObject({ status: "cancelled", hostId: "host-1" });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "two",
        target: { providerId: "prov-1" },
        timeout: 30,
      }).ok,
    ).toBe(true);
    expect(plane.assignQueued()).toEqual([]);
  });

  it("counts a leftover scheduled checkout against the advertised host cap", () => {
    const state = createControlPlaneState();
    state.hostConnection.set("host", "conn");
    state.connections.set("conn", {
      connectionId: "conn",
      type: "host",
      hostId: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      maxConcurrentAssignments: 1,
    });
    state.sessions.set("held", {
      id: "held",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "c" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 1,
      queueExpiresAt: NOW,
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "cancelled",
      queueShard: 0,
      createdAt: NOW,
      hostId: "host",
      providerAccountLease: {
        concurrencyId: "provider-lease:acct:0",
        providerAccountId: "acct",
        slot: 0,
        attemptId: "attempt",
      },
    });
    expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
    const checkout = { ...state.sessions.get("held")!, mainCheckoutLease: true };
    delete checkout.providerAccountLease;
    state.sessions.set("held", checkout);
    expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
  });

  it("rebuilds leases for cancelled in-flight sessions on hydrate", async () => {
    const plane = new ControlPlane();
    plane.state.storage = {
      listAllSessions: async () => [
        {
          id: "held",
          repositoryId: "repo",
          prompt: "p",
          target: { commandId: "c" },
          fallbacks: [],
          targetLabels: [],
          queueTtlSeconds: 1,
          queueExpiresAt: NOW,
          timeout: 1,
          priority: 0,
          requiredLabels: [],
          status: "cancelled",
          queueShard: 0,
          createdAt: NOW,
          hostId: "host",
          providerAccountLease: {
            concurrencyId: "provider-lease:acct:0",
            providerAccountId: "acct",
            slot: 0,
            attemptId: "attempt",
          },
        },
      ],
      listAllWorktrees: async () => [],
      listConnections: async () => [],
      listSchedules: async () => [],
      listRepositories: async () => [],
      listHostInventories: async () => [],
      listProviders: async () => [],
      listProviderAccounts: async () => [],
      listCommands: async () => [],
      listArchives: async () => [],
      listAllAuditLogs: async () => [],
      listLogs: async () => [],
    } as never;
    await plane.hydrateFromStorage();
    expect(plane.state.providerAccountLeases.get("provider-lease:acct:0")).toMatchObject({
      sessionId: "held",
      attemptId: "attempt",
    });
  });

  it("skips occupied slots when acquiring a local lease", () => {
    const state = createControlPlaneState();
    state.providerAccounts.set("acct", {
      id: "acct",
      providerId: "p",
      label: "a",
      createdAt: NOW,
      updatedAt: NOW,
      maxConcurrentSessions: 2,
    });
    const session = { id: "sess", attemptId: "attempt" };
    expect(
      tryAcquireProviderAccountLeaseLocal(
        state,
        session as never,
        "acct",
        "attempt",
        "host",
        new Set([0]),
      )?.slot,
    ).toBe(1);
    expect(
      tryAcquireProviderAccountLeaseLocal(state, session as never, "acct", "fill", "host")?.slot,
    ).toBe(0);
    expect(
      tryAcquireProviderAccountLeaseLocal(
        state,
        session as never,
        "acct",
        "retry",
        "host",
        new Set(),
        false,
      )?.slot,
    ).toBe(0);
    state.storage = { putSession: async () => undefined } as never;
    expect(accountHasLeaseCapacity(state, "acct")).toBe(true);
    expect(hostHasAssignmentCapacity(state, "host")).toBe(true);
    expect(providerAccountLeaseWriteOpts({})).toEqual({});
    expect(
      providerAccountLeaseWriteOpts({
        providerAccountLease: {
          concurrencyId: "provider-lease:acct:0",
          providerAccountId: "acct",
          slot: 0,
          attemptId: "attempt",
        },
      }),
    ).toEqual({
      providerAccountLease: {
        concurrencyId: "provider-lease:acct:0",
        providerAccountId: "acct",
        slot: 0,
        attemptId: "attempt",
      },
    });
  });
});
