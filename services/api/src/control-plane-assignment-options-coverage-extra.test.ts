/* eslint-disable max-lines -- assignment optional-field and queue-order cases share one fixture. */
import { describe, expect, it } from "vitest";

import { assignQueued, assignQueuedDurable } from "./control-plane-assign.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "provider-command" },
    fallbacks: [],
    targetLabels: ["provider-command"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    ...over,
  };
}

function providerState() {
  const state = createControlPlaneState({
    now: () => NOW,
    attemptIdFactory: () => "attempt",
    shardCount: 1,
  });
  state.providers.set("provider", {
    id: "provider",
    name: "provider",
    defaultCommandId: "provider-command",
  });
  state.providerAccounts.set("account", {
    id: "account",
    providerId: "provider",
    label: "account",
  });
  state.commands.set("provider-command", {
    id: "provider-command",
    name: "provider command",
    argv: ["tool"],
    appendPrompt: true,
    providerId: "provider",
  });
  for (const hostId of ["host-a", "host-b"]) {
    const id = `worktree-${hostId}`;
    const worktree: WorktreeRecord = {
      id,
      name: id,
      hostId,
      repositoryId: "repo",
      path: `/repo/${id}`,
      labels: [],
      status: "idle",
      online: true,
      connectionId: `connection-${hostId}`,
    };
    state.worktrees.set(id, worktree);
    state.connections.set(`connection-${hostId}`, {
      hostId,
      connectionId: `connection-${hostId}`,
      type: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 1,
      providerAccountReadiness: [
        { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
      ],
    });
    state.hostConnection.set(hostId, `connection-${hostId}`);
    state.hostInventories.set(hostId, {
      hostId,
      repositories: [{ id: "repo", path: "/repo", worktrees: [] }],
      providerAccounts: [{ providerAccountId: "account" }],
      commandProfiles: {},
      updatedAt: NOW,
    });
  }
  state.sessions.set("s", session());
  return state;
}

describe("assignment optional-field coverage", () => {
  it("orders provider routes with a live cached account", () => {
    expect(assignQueued(providerState())).toHaveLength(1);
  });

  it("backfills queue order before reading the durable assignment queue", async () => {
    const state = providerState();
    let backfills = 0;
    setDurableReadStorage(state, {
      tryAssignSession: async () => true,
      expireQueuedSession: async () => false,
      clearResumePin: async () => true,
      backfillQueuedSessionQueueOrder: async () => {
        backfills += 1;
      },
    });
    await expect(assignQueuedDurable(state)).resolves.toHaveLength(1);
    expect(backfills).toBe(1);
  });

  it("durably publishes provider account route metadata", async () => {
    const state = providerState();
    setDurableReadStorage(state, {
      tryAssignSession: async () => true,
      expireQueuedSession: async () => false,
      clearResumePin: async () => true,
    });
    await expect(assignQueuedDurable(state)).resolves.toMatchObject([
      { session: { resolvedRoute: { providerAccountId: "account" } } },
    ]);
  });

  it("uses legacy metadata ownership for the durable assignment drain fence", async () => {
    const state = providerState();
    state.sessions.set("s", session({ metadata: { createdBy: "principal-legacy" } }));
    let assignedPrincipalId: string | undefined;
    setDurableReadStorage(state, {
      tryAssignSession: async (opts: { principalId?: string }) => {
        assignedPrincipalId = opts.principalId;
        return true;
      },
      expireQueuedSession: async () => false,
      clearResumePin: async () => true,
    });

    await expect(assignQueuedDurable(state)).resolves.toHaveLength(1);
    expect(assignedPrincipalId).toBe("principal-legacy");
  });

  it("expires a durable queued session and passes its concurrency lock to storage", async () => {
    const state = providerState();
    state.sessions.set(
      "s",
      session({ queueExpiresAt: "2025-01-01T00:00:00.000Z", concurrencyId: "lock" }),
    );
    let expired: { concurrencyId?: string } | undefined;
    setDurableReadStorage(state, {
      expireQueuedSession: async (opts: { concurrencyId?: string }) => {
        expired = opts;
        return true;
      },
    });
    await expect(assignQueuedDurable(state)).resolves.toEqual([]);
    expect(expired).toMatchObject({ concurrencyId: "lock" });
    expect(state.sessions.get("s")).toMatchObject({ status: "failed", errorCode: "queue_expired" });
  });

  it("keeps a future pin when durable clearing loses the fence", async () => {
    const state = providerState();
    state.sessions.set(
      "s",
      session({ pinnedHostId: "host-a", pinExpiresAt: "2026-01-02T00:00:00.000Z" }),
    );
    state.commands.delete("provider-command");
    setDurableReadStorage(state, { clearResumePin: async () => false });
    await expect(assignQueuedDurable(state)).resolves.toEqual([]);
    expect(state.sessions.get("s")?.pinnedHostId).toBe("host-a");
  });

  it("queues an expired session through storage in the local compatibility path", async () => {
    const state = providerState();
    state.sessions.set("s", session({ queueExpiresAt: "2025-01-01T00:00:00.000Z" }));
    const writes: SessionRecord[] = [];
    state.storage = { putSession: async (row: SessionRecord) => writes.push(row) } as never;
    expect(assignQueued(state)).toEqual([]);
    await state.writeTail;
    expect(writes[0]).toMatchObject({ status: "failed", errorCode: "queue_expired" });
  });

  it("releases a concurrency lock when local queue expiry persists through storage", async () => {
    const state = providerState();
    state.sessions.set(
      "s",
      session({ queueExpiresAt: "2025-01-01T00:00:00.000Z", concurrencyId: "lock" }),
    );
    const released: string[] = [];
    state.storage = {
      putSession: async () => {},
      releaseConcurrencyLock: async (id: string) => {
        released.push(id);
      },
    } as never;
    expect(assignQueued(state)).toEqual([]);
    await state.writeTail;
    expect(released).toEqual(["lock"]);
    expect(state.sessions.get("s")).toMatchObject({ status: "failed", errorCode: "queue_expired" });
  });

  it("expires queued work before a closed repository can suppress assignment", async () => {
    const state = providerState();
    state.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      admissionState: "paused",
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.sessions.set("s", session({ queueExpiresAt: "2025-01-01T00:00:00.000Z" }));
    const writes: SessionRecord[] = [];
    state.storage = { putSession: async (row: SessionRecord) => writes.push(row) } as never;
    expect(assignQueued(state)).toEqual([]);
    await state.writeTail;
    expect(writes[0]).toMatchObject({ status: "failed", errorCode: "queue_expired" });
  });
});
