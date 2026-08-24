/* eslint-disable max-lines -- assignment, hydrate, and helper cases share one fixture. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  accountHasLeaseCapacity,
  hostHasAssignmentCapacity,
  hostProviderAccountReady,
  maxConcurrentSessionsFor,
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
  });

  it("releases a lease idempotently", async () => {
    const state = createControlPlaneState();
    const session = {
      id: "sess",
      attemptId: "attempt",
      providerAccountLease: {
        concurrencyId: "provider-account:acct:0",
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
        concurrencyId: "provider-account:acct:0",
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
    plane.state.storage = {
      listAllSessions: async () => [
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
            concurrencyId: "provider-account:acct:0",
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
            concurrencyId: "provider-account:acct:1",
            providerAccountId: "acct",
            slot: 1,
            attemptId: "old",
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
    } as never;
    await plane.hydrateFromStorage();
    expect(plane.state.providerAccountLeases.get("provider-account:acct:0")).toMatchObject({
      sessionId: "running",
      attemptId: "attempt",
    });
    expect(plane.state.providerAccountLeases.has("provider-account:acct:1")).toBe(false);
    expect(plane.getProviderAccount("acct")?.maxConcurrentSessions).toBe(1);
  });
});
