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

  it("skips retry-delayed, wrong-shard, unresolved, and lease-lost candidates", async () => {
    const current = state();
    const host = connection("h1", "c1");
    current.connections.set("c1", host);
    current.hostConnection.set("h1", "c1");
    current.sessions.set(
      "delayed",
      session({ id: "delayed", retryAfter: "2026-01-02T00:00:00.000Z" }),
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
});
