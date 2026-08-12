/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "./db/types.ts";
import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ScheduledRace");
const NOW = "2026-01-01T00:00:00.000Z";

function session(id: string, repositoryId = "repo-race"): SessionRecord {
  return {
    id,
    repositoryId,
    prompt: `scheduled:${id}`,
    target: { commandId: "command-race" },
    fallbacks: [],
    targetLabels: ["race command"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    retryCount: 0,
    type: "scheduled",
    source: "schedule",
  };
}

async function putCommand() {
  await ctx.storage!.putCommand({
    id: "command-race",
    name: "race command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function register(
  connectionId: string,
  hostId = "host-race",
  repositories: Array<{ id: string; path: string }> = [{ id: "repo-race", path: "/repo" }],
) {
  const created = await createControlPlane({
    tablePrefix: ctx.prefix,
    skipEnsureTables: true,
    now: () => NOW,
    connectionIdFactory: () => connectionId,
    shardCount: 1,
  });
  const result = await created.plane.registerHostDurable({
    hostId,
    worktrees: [],
    repositories: repositories.map((repository) => ({ ...repository, defaultBranch: "main" })),
    commandProfiles: [],
    capabilities: ["scheduled-main-checkout"],
    replaceExisting: true,
  });
  expect(result).toMatchObject({ ok: true });
  return created;
}

describe("scheduled main-checkout DynamoDB races", () => {
  it("lets two schedulers claim only one host/repository lease", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await putCommand();
    await register("connection-race");
    await ctx.storage.putSession(session("session-race-a"));
    await ctx.storage.putSession(session("session-race-b"));

    const first = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
    });
    const second = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
    });
    await Promise.all([first.plane.hydrateFromStorage(), second.plane.hydrateFromStorage()]);

    const [a, b] = await Promise.all([
      first.plane.assignScheduledQueuedDurable(),
      second.plane.assignScheduledQueuedDurable(),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(await ctx.storage.getMainCheckoutLease("host-race", "repo-race")).toMatchObject({
      connectionId: "connection-race",
    });
    expect(
      (await ctx.storage.listAllSessions()).filter(
        (record) => record.status === "running" && record.mainCheckoutLease,
      ),
    ).toHaveLength(1);
  });

  it("rejects stale connection and inventory caches after host replacement", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await putCommand();
    await register("connection-old", "host-stale");
    await ctx.storage.putSession(session("session-stale", "repo-race"));
    const stale = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
    });
    await stale.plane.hydrateFromStorage();

    await register("connection-new", "host-stale", []);
    const assigned = await stale.plane.assignScheduledQueuedDurable();
    expect(assigned).toEqual([]);
    expect((await ctx.storage.getSession("session-stale"))?.status).toBe("queued");
    expect(await ctx.storage.getMainCheckoutLease("host-stale", "repo-race")).toBeNull();
  });

  it("rejects a stale scheduler after a durable drain wins the condition", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await putCommand();
    const owner = await register("connection-drain", "host-drain");
    await ctx.storage.putSession(session("session-drain"));
    const stale = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
    });
    await stale.plane.hydrateFromStorage();

    expect(await owner.plane.drainHostDurable("host-drain")).toMatchObject({ ok: true });
    expect(await stale.plane.assignScheduledQueuedDurable()).toEqual([]);
    expect((await ctx.storage.getSession("session-drain"))?.status).toBe("queued");
  });

  it("fences a late old terminal report from releasing a newer lease", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await putCommand();
    const repositoryId = "repo-terminal";
    const old = await register("connection-terminal-old", "host-terminal", [
      { id: repositoryId, path: "/repo-terminal" },
    ]);
    await ctx.storage.putSession(session("session-terminal-old", repositoryId));
    await old.plane.hydrateFromStorage();
    expect(await old.plane.assignScheduledQueuedDurable()).toHaveLength(1);

    // Replacement registration omits the old running session, so reconciliation
    // releases its lease before the replacement scheduler can claim the next run.
    const replacement = await register("connection-terminal-new", "host-terminal", [
      { id: repositoryId, path: "/repo-terminal" },
    ]);
    await ctx.storage.putSession(session("session-terminal-new", repositoryId));
    await replacement.plane.hydrateFromStorage();
    expect(await replacement.plane.assignScheduledQueuedDurable()).toHaveLength(1);
    expect(await ctx.storage.getMainCheckoutLease("host-terminal", repositoryId)).toMatchObject({
      sessionId: "session-terminal-new",
      connectionId: "connection-terminal-new",
    });

    const result = await old.plane.handleHostMessageDurable(
      { type: "session:status", sessionId: "session-terminal-old", status: "completed" },
      "connection-terminal-old",
    );
    expect(result).toMatchObject({ ok: false, error: "stale host connection" });
    expect(await ctx.storage.getMainCheckoutLease("host-terminal", repositoryId)).toMatchObject({
      sessionId: "session-terminal-new",
    });
    expect((await ctx.storage.getSession("session-terminal-new"))?.status).toBe("running");
  });

  it("keeps an acknowledged scheduled lease when a stale deadline worker tries to requeue it", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.clearAll();
    await putCommand();
    const hostId = "host-ack-deadline";
    const repositoryId = "repo-ack-deadline";
    const connectionId = "connection-ack-deadline";
    await register(connectionId, hostId, [{ id: repositoryId, path: "/repo-ack-deadline" }]);
    await ctx.storage.putSession(session("session-ack-deadline", repositoryId));

    const assigner = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
      ackDeadlineMs: 1,
    });
    await assigner.plane.hydrateFromStorage();
    expect(await assigner.plane.assignScheduledQueuedDurable()).toHaveLength(1);
    const assigned = await ctx.storage.getSession("session-ack-deadline");
    expect(assigned).toMatchObject({
      status: "running",
      hostId,
      assignmentConnectionId: connectionId,
      mainCheckoutLease: true,
    });
    expect(assigned?.ackReceivedAt).toBeUndefined();

    // This is a separate API process. Its first deadline pass captures the
    // still-unacknowledged durable assignment in its local pending-ack cache.
    const staleDeadlineWorker = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
      ackDeadlineMs: 1,
    });
    await staleDeadlineWorker.plane.hydrateFromStorage();
    expect(await staleDeadlineWorker.plane.enforceAckDeadlinesDurable(Date.parse(NOW))).toEqual([]);

    // A different API node durably accepts the agent ACK after the stale node
    // has populated that cache, but before it attempts its expired release.
    const acknowledger = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
    });
    await acknowledger.plane.hydrateFromStorage();
    expect(
      await acknowledger.plane.handleHostMessageDurable(
        {
          type: "session:ack",
          sessionId: assigned!.id,
          worktreeId: null,
          attemptId: assigned!.attemptId!,
        },
        connectionId,
      ),
    ).toMatchObject({ ok: true, sessionAcknowledged: assigned!.id });

    expect(await staleDeadlineWorker.plane.enforceAckDeadlinesDurable(Date.parse(NOW) + 2)).toEqual(
      [],
    );
    expect(await ctx.storage.getSession(assigned!.id)).toMatchObject({
      status: "running",
      ackReceivedAt: NOW,
      hostId,
      assignmentConnectionId: connectionId,
      mainCheckoutLease: true,
    });
    expect(await ctx.storage.getMainCheckoutLease(hostId, repositoryId)).toEqual({
      sessionId: assigned!.id,
      connectionId,
    });
  });

  it("rejects a stale capability snapshot in the assignment transaction", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const repositoryId = "repo-capability";
    await putCommand();
    await register("connection-cap-old", "host-capability", [
      { id: repositoryId, path: "/repo-capability" },
    ]);
    await ctx.storage.putSession(session("session-capability", repositoryId));
    const stale = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
    });
    await stale.plane.hydrateFromStorage();
    const replacement = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      connectionIdFactory: () => "connection-cap-new",
    });
    expect(
      await replacement.plane.registerHostDurable({
        hostId: "host-capability",
        worktrees: [],
        commandProfiles: [],
        capabilities: [],
        repositories: [{ id: repositoryId, path: "/repo-capability", defaultBranch: "main" }],
        replaceExisting: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await stale.plane.assignScheduledQueuedDurable()).toEqual([]);
    expect((await ctx.storage.getSession("session-capability"))?.status).toBe("queued");
  });

  it("leaves one durable owner after concurrent force registrations", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const owner = await register("connection-force-old", "host-force", [
      { id: "repo-force", path: "/repo-force" },
    ]);
    expect(await owner.plane.disconnectHostDurable("connection-force-old")).toEqual([]);
    const replacements = await Promise.all(
      ["a", "b"].map(async (suffix) => {
        const created = await createControlPlane({
          tablePrefix: ctx.prefix,
          skipEnsureTables: true,
          connectionIdFactory: () => `connection-force-${suffix}`,
        });
        await created.plane.hydrateFromStorage();
        return created.plane.registerHostDurable({
          hostId: "host-force",
          worktrees: [],
          commandProfiles: [],
          capabilities: ["scheduled-main-checkout"],
          repositories: [{ id: "repo-force", path: "/repo-force", defaultBranch: "main" }],
          replaceExisting: true,
        });
      }),
    );
    expect(replacements.some((result) => result.ok)).toBe(true);
    const durableConnections = (await ctx.storage.listConnections()).filter(
      (connection) => connection.hostId === "host-force",
    );
    expect(durableConnections).toHaveLength(1);
    expect(await ctx.storage.getHostLock("host-force")).toBe(durableConnections[0]!.connectionId);
  });
});
