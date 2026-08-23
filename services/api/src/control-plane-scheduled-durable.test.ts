import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import type { SessionRecord } from "./db/types.ts";
import { createDynamoTestCtx, putActiveTestRepository } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("SchedLease");

describe("durable scheduled main-checkout leases", () => {
  it("allows one concurrent claim and releases only the owning terminal session", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    await putActiveTestRepository(ctx.storage, "repository");
    await ctx.storage.putCommand({
      id: "command",
      name: "echo",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const first = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
      connectionIdFactory: () => "connection",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(
      (
        await first.plane.registerHostDurable({
          hostId: "host",
          worktrees: [],
          commandProfiles: [],
          capabilities: ["scheduled-main-checkout"],
          repositories: [{ id: "repository", path: "/repo", defaultBranch: "main" }],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    const base: SessionRecord = {
      id: "scheduled-a",
      repositoryId: "repository",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["echo"],
      queueTtlSeconds: 3600,
      queueExpiresAt: "2026-01-01T01:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      retryCount: 0,
      type: "scheduled",
      source: "schedule",
      principalId: "system",
    };
    await ctx.storage.putSession(base);
    await ctx.storage.putSession({
      ...base,
      id: "scheduled-b",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const second = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
    });
    await Promise.all([first.plane.hydrateFromStorage(), second.plane.hydrateFromStorage()]);
    const [one, two] = await Promise.all([
      first.plane.assignScheduledQueuedDurable(),
      second.plane.assignScheduledQueuedDurable(),
    ]);
    expect(one.length + two.length).toBe(1);
    const winner = await ctx.storage.getSession("scheduled-a");
    expect(winner ?? (await ctx.storage.getSession("scheduled-b"))).toMatchObject({
      status: "running",
      worktreeId: null,
      mainCheckoutLease: true,
    });
    const running = (await ctx.storage.listAllSessions()).find(
      (session) => session.status === "running",
    )!;
    const loser = running.id === "scheduled-a" ? "scheduled-b" : "scheduled-a";
    expect(
      await ctx.storage.releaseMainCheckoutSession({
        sessionId: loser,
        hostId: "host",
        repositoryId: "repository",
        connectionId: "connection",
        status: "completed",
        queueShard: 0,
        completedAt: "2026-01-01T00:00:02.000Z",
      }),
    ).toBe(false);
    expect(
      await ctx.storage.releaseMainCheckoutSession({
        sessionId: running.id,
        hostId: "host",
        repositoryId: "repository",
        connectionId: "connection",
        status: "completed",
        queueShard: 0,
        completedAt: "2026-01-01T00:00:02.000Z",
      }),
    ).toBe(true);
    expect((await ctx.storage.getSession(running.id))?.mainCheckoutLease).toBeUndefined();
  });
});
