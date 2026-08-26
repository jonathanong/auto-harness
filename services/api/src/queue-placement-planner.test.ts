/* eslint-disable max-lines -- starvation, expiry, and D8 placement cases share one fixture. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { assignQueued } from "./control-plane-assign.ts";
import { assignScheduledQueuedDurable } from "./control-plane-scheduled-assign.ts";
import { buildProviderCatalog } from "./control-plane-session-target.ts";
import { BASE_COMMAND_ID, seedBaseCommand } from "./control-plane-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";
import {
  explainPromptPlacement,
  planPromptPlacement,
  planScheduledPlacement,
  targetIsAvailable,
} from "./queue-placement-planner.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo-1",
    prompt: "p",
    target: { commandId: BASE_COMMAND_ID },
    fallbacks: [],
    targetDisplayNames: [BASE_COMMAND_ID],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    ...over,
  };
}

function markHostReady(plane: ControlPlane, hostId: string, repositoryId = "repo-1"): void {
  const connectionId = `${hostId}-connection`;
  plane.state.connections.set(connectionId, {
    connectionId,
    type: "host",
    hostId,
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    capabilities: ["scheduled-main-checkout"],
    repositoryIds: [repositoryId],
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    protocolVersion: 1,
  });
  plane.state.hostConnection.set(hostId, connectionId);
  plane.state.hostInventories.set(hostId, {
    hostId,
    repositories: [
      { id: repositoryId, path: `/${repositoryId}`, defaultBranch: "main", worktrees: [] },
    ],
    providerAccounts: [],
    commandProfiles: {},
    updatedAt: NOW,
  });
}

describe("queue placement planner", () => {
  it("explains expired, closed, and unroutable prompt sessions", () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    seedBaseCommand(plane);
    const catalog = buildProviderCatalog(plane.state);
    expect(
      explainPromptPlacement(
        plane.state,
        catalog,
        session({ queueExpiresAt: "2025-01-01T00:00:00.000Z" }),
        Date.parse(NOW),
      ),
    ).toBe("queue_expired");
    plane.state.repositories.set("repo-1", {
      id: "repo-1",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      admissionState: "paused",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(explainPromptPlacement(plane.state, catalog, session(), Date.parse(NOW))).toBe(
      "admission_closed",
    );
    plane.state.repositories.get("repo-1")!.admissionState = "active";
    expect(
      explainPromptPlacement(
        plane.state,
        catalog,
        session({ hostId: "h", worktreeId: "w", ackReceivedAt: NOW }),
        Date.parse(NOW),
      ),
    ).toBe("already_assigned");
    expect(explainPromptPlacement(plane.state, catalog, session(), Date.parse(NOW))).toBe(
      "no_idle_worktree",
    );
    markHostReady(plane, "host");
    plane.seedWorktree({
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    expect(
      explainPromptPlacement(
        plane.state,
        catalog,
        session({ target: { commandId: "missing" }, targetDisplayNames: ["missing"] }),
        Date.parse(NOW),
      ),
    ).toBe("no_eligible_route");
    expect(explainPromptPlacement(plane.state, catalog, session(), Date.parse(NOW))).toBe(
      "assignable",
    );
    expect(
      explainPromptPlacement(
        plane.state,
        catalog,
        session({ requiredLabels: ["gpu"] }),
        Date.parse(NOW),
      ),
    ).toBe("no_idle_worktree");
    plane.state.drainingHosts.add("host");
    expect(
      targetIsAvailable(plane.state, catalog, { commandId: BASE_COMMAND_ID }, Date.parse(NOW)),
    ).toBe(false);
    plane.state.drainingHosts.delete("host");
    plane.state.worktrees.get("wt")!.online = false;
    expect(
      targetIsAvailable(plane.state, catalog, { commandId: BASE_COMMAND_ID }, Date.parse(NOW)),
    ).toBe(false);
    plane.state.worktrees.get("wt")!.online = true;
    plane.state.disconnectedHosts.set("host", { lastHeartbeatAt: NOW });
    expect(
      targetIsAvailable(plane.state, catalog, { commandId: BASE_COMMAND_ID }, Date.parse(NOW)),
    ).toBe(false);
  });

  it("withholds prompt capacity from daemons below the fenced protocol", () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    seedBaseCommand(plane);
    markHostReady(plane, "host");
    const connection = plane.state.connections.get("host-connection")!;
    plane.state.connections.set("host-connection", { ...connection, protocolVersion: 0 });
    plane.seedWorktree({
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    const catalog = buildProviderCatalog(plane.state);
    expect(explainPromptPlacement(plane.state, catalog, session(), Date.parse(NOW))).toBe(
      "no_idle_worktree",
    );
    expect(
      targetIsAvailable(plane.state, catalog, { commandId: BASE_COMMAND_ID }, Date.parse(NOW)),
    ).toBe(false);
    plane.state.connections.set("host-connection", { ...connection, protocolVersion: 1 });
    expect(explainPromptPlacement(plane.state, catalog, session(), Date.parse(NOW))).toBe(
      "assignable",
    );
  });

  it("clears an unusable resume pin and reports assignable capacity", () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    seedBaseCommand(plane);
    markHostReady(plane, "host");
    plane.seedWorktree({
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    const catalog = buildProviderCatalog(plane.state);
    expect(
      planPromptPlacement(
        plane.state,
        catalog,
        session({ pinnedHostId: "missing", pinExpiresAt: "2025-01-01T00:00:00.000Z" }),
        Date.parse(NOW),
      ).action,
    ).toBe("clear_pin");
    expect(
      planPromptPlacement(
        plane.state,
        catalog,
        session({ pinnedHostId: "ghost", pinnedTargetIndex: 0 }),
        Date.parse(NOW),
      ).action,
    ).toBe("clear_pin");
    expect(planPromptPlacement(plane.state, catalog, session(), Date.parse(NOW)).action).toBe(
      "assign",
    );
    expect(
      explainPromptPlacement(
        plane.state,
        catalog,
        session({ pinnedHostId: "missing", pinExpiresAt: "2025-01-01T00:00:00.000Z" }),
        Date.parse(NOW),
      ),
    ).toBe("assignable");
    expect(
      explainPromptPlacement(
        plane.state,
        catalog,
        session({ pinnedHostId: "ghost", requiredLabels: ["gpu"] }),
        Date.parse(NOW),
      ),
    ).toBe("no_idle_worktree");
    expect(
      targetIsAvailable(plane.state, catalog, { commandId: BASE_COMMAND_ID }, Date.parse(NOW)),
    ).toBe(true);
  });

  it("clears a resume pin when its provider profile is no longer ready", () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    plane.state.providers.set("prov", { id: "prov", name: "prov", defaultCommandId: "cmd" });
    plane.state.commands.set("cmd", {
      id: "cmd",
      name: "cmd",
      argv: ["tool"],
      appendPrompt: false,
      providerId: "prov",
    });
    plane.state.providerAccounts.set("acct", {
      id: "acct",
      providerId: "prov",
      label: "account",
    });
    markHostReady(plane, "host");
    const connection = plane.state.connections.get("host-connection")!;
    plane.state.connections.set("host-connection", {
      ...connection,
      providerAccountReadiness: [
        { providerAccountId: "acct", ready: false, fingerprint: "a".repeat(64) },
      ],
    });
    plane.seedWorktree({
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });

    expect(
      planPromptPlacement(
        plane.state,
        buildProviderCatalog(plane.state),
        session({
          target: { providerId: "prov" },
          pinnedHostId: "host",
          pinnedProviderAccountId: "acct",
          pinnedTargetIndex: 0,
        }),
        Date.parse(NOW),
      ),
    ).toEqual({ action: "clear_pin" });
  });

  it("assigns a later shard's higher-priority session before draining shard 0", () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 2 });
    seedBaseCommand(plane);
    markHostReady(plane, "host");
    plane.seedWorktree({
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.state.sessions.set(
      "low",
      session({ id: "low", queueShard: 0, priority: 0, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    plane.state.sessions.set(
      "high",
      session({ id: "high", queueShard: 1, priority: 20, createdAt: "2026-01-01T00:00:01.000Z" }),
    );
    const assigned = assignQueued(plane.state);
    expect(assigned.map((item) => item.session.id)).toEqual(["high"]);
    expect(plane.state.sessions.get("low")?.status).toBe("queued");
  });

  it("expires a scheduled queue lease and releases it like a prompt session", async () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    seedBaseCommand(plane);
    markHostReady(plane, "host");
    plane.state.sessions.set(
      "due",
      session({
        id: "due",
        type: "scheduled",
        source: "schedule",
        principalId: "system",
        queueExpiresAt: "2025-12-31T00:00:00.000Z",
        concurrencyId: "sched-lock",
      }),
    );
    await expect(assignScheduledQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(plane.state.sessions.get("due")).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });
  });

  it("cancels a draining scheduled occurrence and skips a host without a route", async () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    seedBaseCommand(plane);
    markHostReady(plane, "host");
    plane.state.repositories.set("repo-1", {
      id: "repo-1",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      admissionState: "draining",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const row = session({
      id: "drain",
      type: "scheduled",
      source: "schedule",
      principalId: "system",
    });
    expect(
      planScheduledPlacement(plane.state, buildProviderCatalog(plane.state), row, [
        { hostId: "host", connectionId: "host-connection" },
      ]).action,
    ).toBe("cancel");
    plane.state.repositories.get("repo-1")!.admissionState = "active";
    expect(
      planScheduledPlacement(
        plane.state,
        buildProviderCatalog(plane.state),
        session({ id: "orphan", type: "scheduled", source: "schedule" }),
        [],
      ),
    ).toMatchObject({ action: "cancel", reason: "missing_principal" });
    expect(
      planScheduledPlacement(
        plane.state,
        buildProviderCatalog(plane.state),
        session({ id: "stuck", type: "scheduled", source: "schedule", principalId: "system" }),
        [],
      ),
    ).toMatchObject({ action: "skip", reason: "no_eligible_host" });
    expect(
      planScheduledPlacement(
        plane.state,
        buildProviderCatalog(plane.state),
        session({
          id: "unroutable",
          type: "scheduled",
          source: "schedule",
          principalId: "system",
          target: { commandId: "missing" },
        }),
        [{ hostId: "host", connectionId: "host-connection" }],
      ),
    ).toMatchObject({ action: "skip", reason: "no_eligible_route" });
    plane.state.repositories.get("repo-1")!.admissionState = "paused";
    expect(
      planScheduledPlacement(
        plane.state,
        buildProviderCatalog(plane.state),
        session({ id: "paused", type: "scheduled", source: "schedule", principalId: "system" }),
        [{ hostId: "host", connectionId: "host-connection" }],
      ),
    ).toMatchObject({ action: "skip", reason: "admission_closed" });
  });

  it("selects a later ready account on the same worktree", () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    plane.state.providers.set("prov", { id: "prov", name: "prov", defaultCommandId: "cmd" });
    plane.state.commands.set("cmd", {
      id: "cmd",
      name: "cmd",
      argv: ["tool"],
      appendPrompt: false,
      providerId: "prov",
    });
    plane.state.providerAccounts.set("acct-a", {
      id: "acct-a",
      providerId: "prov",
      label: "a",
      lastAssignedAt: "2025-01-01T00:00:00.000Z",
    });
    plane.state.providerAccounts.set("acct-b", {
      id: "acct-b",
      providerId: "prov",
      label: "b",
      lastAssignedAt: "2025-06-01T00:00:00.000Z",
    });
    markHostReady(plane, "host");
    const connection = plane.state.connections.get("host-connection")!;
    plane.state.connections.set("host-connection", {
      ...connection,
      providerAccountReadiness: [
        { providerAccountId: "acct-a", ready: false, fingerprint: "a".repeat(64) },
        { providerAccountId: "acct-b", ready: true, fingerprint: "b".repeat(64) },
      ],
    });
    plane.state.hostInventories.set("host", {
      ...plane.state.hostInventories.get("host")!,
      providerAccounts: [{ providerAccountId: "acct-a" }, { providerAccountId: "acct-b" }],
    });
    plane.seedWorktree({
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    const plan = planPromptPlacement(
      plane.state,
      buildProviderCatalog(plane.state),
      session({ target: { providerId: "prov" }, targetDisplayNames: ["prov"] }),
      Date.parse(NOW),
    );
    expect(plan).toMatchObject({
      action: "assign",
      candidates: [{ route: { providerAccountId: "acct-b" } }],
    });
    expect(
      targetIsAvailable(
        plane.state,
        buildProviderCatalog(plane.state),
        { providerId: "prov" },
        Date.parse(NOW),
      ),
    ).toBe(true);
  });
});
