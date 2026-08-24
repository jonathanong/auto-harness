/* eslint-disable max-lines -- scheduled assignment branch cases share compact state builders. */
import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import {
  assignScheduledQueuedDurable,
  releaseScheduledLeaseLocal,
} from "./control-plane-scheduled-assign.ts";
import type { ConnectionRecord } from "./db/plane-storage-types.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    principalId: "system",
    ...over,
  };
}

function connection(
  hostId: string,
  connectionId: string,
  repositoryIds = ["repo"],
): ConnectionRecord {
  return {
    hostId,
    connectionId,
    type: "host",
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    commandProfiles: [],
    capabilities: ["scheduled-main-checkout"],
    repositoryIds,
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
  };
}

function state() {
  const current = createControlPlaneState({ now: () => NOW, shardCount: 1 });
  current.commands.set("cmd", {
    id: "cmd",
    name: "cmd",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  current.hostInventories.set("h1", {
    hostId: "h1",
    repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
    providerAccounts: [],
    commandProfiles: {},
    updatedAt: NOW,
  });
  return current;
}

describe("scheduled assignment branch coverage", () => {
  it("leaves a queued occurrence paused until activation", async () => {
    const current = state();
    current.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      admissionState: "paused",
      createdAt: NOW,
      updatedAt: NOW,
    });
    current.sessions.set("s", session());
    await expect(assignScheduledQueuedDurable(current)).resolves.toEqual([]);
    expect(current.sessions.get("s")).toMatchObject({ status: "queued" });
  });

  it("cancels a queued occurrence while repository admission drains", async () => {
    const current = state();
    current.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "url",
      admissionState: "draining",
      createdAt: NOW,
      updatedAt: NOW,
    });
    current.sessions.set("s", session());
    await expect(assignScheduledQueuedDurable(current)).resolves.toEqual([]);
    expect(current.sessions.get("s")).toMatchObject({
      status: "cancelled",
      completedAt: NOW,
    });
  });

  it("filters stale, unsupported, repository-missing, draining, disconnected, and leased hosts", async () => {
    const current = state();
    const good = connection("h1", "good");
    const stale = connection("stale", "stale-connection");
    const unsupported = { ...connection("unsupported", "unsupported"), capabilities: [] };
    const wrongRepo = connection("wrong-repo", "wrong", ["other"]);
    current.connections.set("good", good);
    current.connections.set("stale", stale);
    current.connections.set("unsupported", unsupported);
    current.connections.set("wrong", wrongRepo);
    current.hostConnection.set("h1", "good");
    current.hostConnection.set("stale", "newer");
    current.hostConnection.set("unsupported", "unsupported");
    current.hostConnection.set("wrong-repo", "wrong");
    current.drainingHosts.add("h1");
    current.disconnectedHosts.set("h1", { lastHeartbeatAt: NOW });
    current.mainCheckoutLeases.set("h1\0repo", { sessionId: "other", connectionId: "good" });
    current.sessions.set("s", session({ ref: "main", metadata: { source: "test" } }));
    await expect(assignScheduledQueuedDurable(current)).resolves.toEqual([]);
  });

  it("assigns in memory, uses cursor ordering, and emits a no-worktree assignment", async () => {
    const current = state();
    current.hostInventories.set("h2", { ...current.hostInventories.get("h1")!, hostId: "h2" });
    const first = connection("h1", "c1");
    const second = connection("h2", "c2");
    current.connections.set("c1", first);
    current.connections.set("c2", second);
    current.hostConnection.set("h1", "c1");
    current.hostConnection.set("h2", "c2");
    current.sessions.set("s", session({ ref: "main", metadata: { source: "test" } }));
    const messages: unknown[] = [];
    current.onHostMessage = (_host, message) => messages.push(message);
    const assigned = await assignScheduledQueuedDurable(current);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ hostId: "h1", worktreeId: null });
    expect(current.sessions.get("s")).toMatchObject({
      status: "running",
      assignmentSentAt: NOW,
      worktreeId: null,
    });
    expect(current.pendingAcks.get("s")).toMatchObject({
      worktreeId: null,
      assignedAtMs: Date.parse(NOW),
    });
    expect(messages[0]).toMatchObject({
      type: "session:assign",
      sessionType: "scheduled",
      worktreeId: null,
      resolvedArgv: ["echo", "run"],
      ref: "main",
      metadata: { source: "test" },
    });
  });

  it("expires queued work and skips wrong-shard, unresolved, and lease-lost candidates", async () => {
    const current = state();
    const host = connection("h1", "c1");
    current.connections.set("c1", host);
    current.hostConnection.set("h1", "c1");
    current.sessions.set(
      "expired",
      session({ id: "expired", queueExpiresAt: "2025-01-01T00:00:00.000Z" }),
    );
    current.sessions.set("wrong-shard", session({ id: "wrong-shard", queueShard: 1 }));
    current.sessions.set(
      "unresolved",
      session({ id: "unresolved", target: { commandId: "missing" } }),
    );
    current.sessions.set("won-by-other", session({ id: "won-by-other" }));
    current.mainCheckoutLeases.set("h1\0repo", {
      sessionId: "won-by-other",
      connectionId: "other",
    });
    expect(await assignScheduledQueuedDurable(current)).toEqual([]);

    current.mainCheckoutLeases.delete("h1\0repo");
    setDurableReadStorage(current, {
      getMainCheckoutCursor: async () => null,
      ensureMainCheckoutLeaseMap: async () => true,
      tryAssignMainCheckoutSession: async () => false,
    });
    current.sessions.set("storage-lost", session({ id: "storage-lost" }));
    expect(await assignScheduledQueuedDurable(current)).toEqual([]);
  });

  it("expires a durable scheduled queue row and releases its concurrency lock", async () => {
    const current = state();
    current.sessions.set(
      "s",
      session({ queueExpiresAt: "2025-01-01T00:00:00.000Z", concurrencyId: "lock" }),
    );
    const calls: unknown[] = [];
    setDurableReadStorage(current, {
      expireQueuedSession: async (opts: { concurrencyId?: string }) => {
        calls.push(opts);
        return true;
      },
    });
    await expect(assignScheduledQueuedDurable(current)).resolves.toEqual([]);
    expect(calls[0]).toMatchObject({ sessionId: "s", concurrencyId: "lock" });
    expect(current.sessions.get("s")).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });
  });

  it("leaves a scheduled row queued when durable expiry loses its fence", async () => {
    const current = state();
    current.sessions.set("s", session({ queueExpiresAt: "2025-01-01T00:00:00.000Z" }));
    setDurableReadStorage(current, { expireQueuedSession: async () => false });
    await expect(assignScheduledQueuedDurable(current)).resolves.toEqual([]);
    expect(current.sessions.get("s")?.status).toBe("queued");
  });

  it("rejects local lease release unless the exact fence still owns it", () => {
    const current = state();
    const row = session({
      status: "running",
      hostId: "h1",
      assignmentConnectionId: "c1",
      mainCheckoutLease: true,
    });
    expect(releaseScheduledLeaseLocal(current, row)).toBe(false);
    current.mainCheckoutLeases.set("h1\0repo", { sessionId: "other", connectionId: "c1" });
    expect(releaseScheduledLeaseLocal(current, row)).toBe(false);
    current.mainCheckoutLeases.set("h1\0repo", { sessionId: "s", connectionId: "other" });
    expect(releaseScheduledLeaseLocal(current, row)).toBe(false);
    current.mainCheckoutLeases.set("h1\0repo", { sessionId: "s", connectionId: "c1" });
    expect(releaseScheduledLeaseLocal(current, row)).toBe(true);
  });

  it("skips a host whose connection becomes unready after eligibility is computed", async () => {
    const current = state();
    current.connections.set("c1", connection("h1", "c1"));
    current.hostConnection.set("h1", "c1");
    setDurableReadStorage(current, {
      getMainCheckoutCursor: async () => {
        current.connections.set("c2", {
          ...connection("h1", "c2"),
          runtime: {
            daemonVersion: "test",
            gitVersion: null,
            gitReady: false,
            gitReadinessReason: "git_unavailable",
          },
        });
        current.hostConnection.set("h1", "c2");
        return "";
      },
      ensureMainCheckoutLeaseMap: async () => true,
      tryAssignMainCheckoutSession: async () => true,
    });
    current.sessions.set("vanished", session({ id: "vanished" }));
    expect(await assignScheduledQueuedDurable(current)).toEqual([]);
  });

  it("cancels when ownership disappears after placement chooses a host", async () => {
    const current = state();
    current.connections.set("c1", connection("h1", "c1"));
    current.hostConnection.set("h1", "c1");
    const row = session({ principalId: undefined });
    let reads = 0;
    Object.defineProperty(row, "principalId", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "principal" : undefined;
      },
    });
    current.sessions.set("s", row);
    await expect(assignScheduledQueuedDurable(current)).resolves.toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(current.sessions.get("s")?.status).toBe("cancelled");
  });

  it("claims with a missing or unversioned host inventory fence", async () => {
    const versions: Array<number | null> = [];
    for (const inventory of [
      undefined,
      {
        hostId: "h1",
        repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
        providerAccounts: [],
        commandProfiles: {},
        updatedAt: NOW,
      },
    ] as const) {
      const current = state();
      current.connections.set("c1", connection("h1", "c1"));
      current.hostConnection.set("h1", "c1");
      if (inventory) current.hostInventories.set("h1", inventory);
      else current.hostInventories.delete("h1");
      current.sessions.set("s", session());
      setDurableReadStorage(current, {
        getMainCheckoutCursor: async () => "",
        ensureMainCheckoutLeaseMap: async () => {
          if (!inventory) current.hostInventories.delete("h1");
          return true;
        },
        tryAssignMainCheckoutSession: async (opts: { hostInventoryVersion: number | null }) => {
          versions.push(opts.hostInventoryVersion);
          return true;
        },
      });
      if (!inventory) {
        current.hostInventories.set("h1", {
          hostId: "h1",
          repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
          providerAccounts: [],
          commandProfiles: {},
          updatedAt: NOW,
        });
      }
      await expect(assignScheduledQueuedDurable(current)).resolves.toHaveLength(1);
    }
    expect(versions).toEqual([null, 0]);
  });
});
