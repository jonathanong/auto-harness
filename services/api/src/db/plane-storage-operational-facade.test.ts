import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";
import { createDynamoClients, tableNames } from "./dynamo.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import type { SessionRecord } from "./types.ts";

const ctx = createDynamoTestCtx("OperationalFacade");
const NOW = "2026-01-01T00:00:00.000Z";

function storage() {
  if (!ctx.available || !ctx.storage) throw new Error("DynamoDB Local is required");
  return ctx.storage;
}

function session(id: string): SessionRecord {
  return {
    id,
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: NOW,
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "failed",
    queueShard: 0,
    createdAt: NOW,
    completedAt: NOW,
    attemptId: "attempt",
    errorCode: "checkout_fetch_failed",
  };
}

describe("operational storage facade", () => {
  it("keeps repository cursor progress scoped to its drain and exposes empty sparse recovery", async () => {
    const store = storage();
    await store.saveRepositoryActivityCursor("repo", "drain", { recordKey: "ACT#next" });
    expect(await store.loadRepositoryActivityCursor("repo", "drain")).toEqual({
      recordKey: "ACT#next",
    });
    expect(await store.loadRepositoryActivityCursor("repo", "new-drain")).toBeUndefined();
    await store.saveRepositoryActivityCursor("repo", "drain");
    expect(await store.loadRepositoryActivityCursor("repo", "drain")).toBeUndefined();
    await expect(store.listRepositoryOperationalPage("repo")).resolves.toEqual({
      sessions: [],
      observedMembers: 0,
    });
    await expect(store.listOperationalSessions(1)).resolves.toEqual([]);
    await expect(store.listOperationalRecoveryPage("ack", 1)).resolves.toEqual([]);
  });

  it("durably records settled and expired generations without replacing an existing delivery marker", async () => {
    const store = storage();
    const settled = {
      ...session("settled"),
      terminalHookHandoffSettled: { handoffId: "handoff", hostId: "host" },
    };
    await store.putSession(settled);
    await expect(store.markTerminalHookLifecycleEnqueued(settled, NOW)).resolves.toBe(true);
    await expect(
      store.markTerminalHookLifecycleEnqueued(settled, "2026-01-02T00:00:00.000Z"),
    ).resolves.toBe(true);
    expect((await store.getSession(settled.id, true))?.terminalHookLifecycleEnqueuedAt).toBe(NOW);
    const expired = { ...session("expired"), terminalHookHandoffExpiredAt: NOW };
    await store.putSession(expired);
    await expect(store.markTerminalHookLifecycleEnqueued(expired, NOW)).resolves.toBe(true);
    expect((await store.getSession(expired.id, true))?.terminalHookLifecycleEnqueuedAt).toBe(NOW);
  });

  it("rejects a stale hook generation and propagates an unavailable table", async () => {
    const store = storage();
    const old = { ...session("stale"), terminalHookHandoffExpiredAt: NOW };
    await store.putSession({ ...old, attemptId: "replacement-attempt" });
    await expect(store.markTerminalHookLifecycleEnqueued(old, NOW)).resolves.toBe(false);
    expect((await store.getSession(old.id, true))?.terminalHookLifecycleEnqueuedAt).toBeUndefined();
    const { client, doc } = createDynamoClients();
    try {
      const missing = new DynamoPlaneStorageBase(doc, tableNames(`${ctx.prefix}Missing`));
      await expect(missing.markTerminalHookLifecycleEnqueued(old, NOW)).rejects.toMatchObject({
        name: "ResourceNotFoundException",
      });
    } finally {
      client.destroy();
    }
  });
});
