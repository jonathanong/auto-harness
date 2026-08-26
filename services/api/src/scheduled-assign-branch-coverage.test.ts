import { describe, expect, it } from "vitest";

import { buildRegisteredInventory } from "./control-plane-agent-registration.ts";
import { assignScheduledQueuedDurable } from "./control-plane-scheduled-assign.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function queued(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    repositoryId: "repo",
    principalId: "principal",
    prompt: id,
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 10,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    ...over,
  };
}

function addHost(
  state: ReturnType<typeof createControlPlaneState>,
  hostId: string,
  connectionId: string,
  capabilities: string[] = ["scheduled-main-checkout"],
  repositories = ["repo"],
) {
  state.connections.set(connectionId, {
    connectionId,
    type: "host",
    hostId,
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    capabilities: capabilities as never,
    repositoryIds: repositories,
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    protocolVersion: 1,
  });
  state.hostConnection.set(hostId, connectionId);
  state.hostInventories.set(
    hostId,
    buildRegisteredInventory(
      hostId,
      repositories.map((id) => ({ id, path: `/${hostId}/${id}` })),
      [],
      capabilities as never,
      NOW,
    ),
  );
}

function baseState() {
  const state = createControlPlaneState({ now: () => NOW, shardCount: 1 });
  state.commands.set("cmd", {
    id: "cmd",
    name: "cmd",
    argv: ["tool"],
    appendPrompt: true,
    providerId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return state;
}

describe("scheduled assignment branch coverage", () => {
  it("skips stale, incapable, unavailable, leased, delayed, and unresolved candidates", async () => {
    const state = baseState();
    addHost(state, "stale", "stale-connection");
    state.hostConnection.set("stale", "newer-connection");
    addHost(state, "incapable", "incapable-connection", []);
    addHost(state, "wrong-repo", "wrong-repo-connection", undefined, ["other"]);
    addHost(state, "draining", "draining-connection");
    state.drainingHosts.add("draining");
    addHost(state, "offline", "offline-connection");
    state.disconnectedHosts.set("offline", { lastHeartbeatAt: NOW });
    addHost(state, "leased", "leased-connection");
    state.mainCheckoutLeases.set("leased\0repo", { sessionId: "old", connectionId: "old" });
    addHost(state, "good", "good-connection");
    state.sessions.set(
      "expired",
      queued("expired", {
        queueExpiresAt: "2025-01-01T00:00:00.000Z",
        concurrencyId: "expired-lock",
      }),
    );
    state.sessions.set("missing", queued("missing", { target: { commandId: "missing" } }));
    state.sessions.set("run", queued("run", { ref: "main", metadata: { source: "test" } }));

    await expect(assignScheduledQueuedDurable(state)).resolves.toMatchObject([
      { hostId: "good", worktreeId: null, session: { id: "run", status: "running" } },
    ]);
    expect(state.sessions.get("expired")).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });
    expect(state.sessions.get("missing")?.status).toBe("queued");
    expect(state.mainCheckoutLeases.get("good\0repo")).toMatchObject({ sessionId: "run" });
  });

  it("handles durable map setup and claim losses without publishing assignments", async () => {
    const state = baseState();
    addHost(state, "host", "connection");
    state.sessions.set("run", queued("run"));
    const calls: string[] = [];
    setDurableReadStorage(state, {
      getMainCheckoutCursor: async () => null,
      ensureMainCheckoutLeaseMap: async () => (calls.push("map"), false),
      tryAssignMainCheckoutSession: async () => (calls.push("claim"), true),
    });
    await expect(state.storage!.listSessionsByStatus("queued", 0)).resolves.toHaveLength(1);
    await expect(state.storage!.listConnections()).resolves.toHaveLength(1);
    await expect(assignScheduledQueuedDurable(state)).resolves.toEqual([]);
    expect(calls).toEqual(["map"]);
    state.storage.ensureMainCheckoutLeaseMap = async () => (calls.push("map-ok"), true);
    state.storage.tryAssignMainCheckoutSession = async () => (calls.push("claim-lost"), false);
    await expect(assignScheduledQueuedDurable(state)).resolves.toEqual([]);
    expect(calls).toEqual(["map", "map-ok", "claim-lost"]);
  });

  it("uses legacy metadata ownership for the durable main-checkout drain fence", async () => {
    const state = baseState();
    addHost(state, "host", "connection");
    state.sessions.set(
      "run",
      queued("run", {
        principalId: undefined,
        metadata: { createdBy: "principal-legacy" },
      }),
    );
    let assignedPrincipalId: string | undefined;
    setDurableReadStorage(state, {
      getMainCheckoutCursor: async () => null,
      ensureMainCheckoutLeaseMap: async () => true,
      tryAssignMainCheckoutSession: async (opts: { principalId?: string }) => {
        assignedPrincipalId = opts.principalId;
        return true;
      },
    });

    await expect(assignScheduledQueuedDurable(state)).resolves.toHaveLength(1);
    expect(assignedPrincipalId).toBe("principal-legacy");
  });

  it("cancels an ownerless legacy scheduled session before assignment", async () => {
    const state = baseState();
    addHost(state, "host", "connection");
    state.sessions.set("run", queued("run", { principalId: undefined }));
    let attempted = false;
    setDurableReadStorage(state, {
      getMainCheckoutCursor: async () => null,
      ensureMainCheckoutLeaseMap: async () => true,
      cancelQueuedSession: async () => true,
      tryAssignMainCheckoutSession: async () => {
        attempted = true;
        return true;
      },
    });

    await expect(assignScheduledQueuedDurable(state)).resolves.toEqual([]);
    expect(attempted).toBe(false);
    expect(state.sessions.get("run")?.status).toBe("cancelled");
  });
});
