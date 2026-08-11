import { describe, expect, it } from "vitest";

import { assignQueuedDurable } from "./control-plane-assign.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("P34DurCov");

describe("durable control-plane core edge coverage", () => {
  it("persists a durable queue expiry before removing it from the assignment queue", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({
      storage: ctx.storage,
      now: () => "2026-01-01T00:00:10.000Z",
      shardCount: 1,
    });
    await ctx.storage.putSession({
      id: "expired",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetLabels: ["cmd"],
      queueTtlSeconds: 1,
      queueExpiresAt: "2026-01-01T00:00:01.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      type: "prompt",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(assignQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(plane.getSession("expired")).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });
    await expect(ctx.storage.getSession("expired")).resolves.toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });
  });

  it("keeps a duplicate durable acknowledgement idempotently successful", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({
      storage: ctx.storage,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const session = {
      id: "ack-session",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetLabels: ["cmd"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue" as const,
      status: "running" as const,
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "worktree",
      attemptId: "attempt",
    };
    await ctx.storage.putSession(session);

    await expect(
      handleHostMessageDurable(plane.state, {
        type: "session:ack",
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
      }),
    ).resolves.toEqual({ ok: true, sessionAcknowledged: session.id });
    await expect(
      handleHostMessageDurable(plane.state, {
        type: "session:ack",
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(ctx.storage.getSession(session.id)).resolves.toMatchObject({
      ackReceivedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("acquires a non-replacing durable host lease for a first registration", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => "connection",
    });

    await expect(
      handleHostMessageDurable(plane.state, {
        type: "host:register",
        hostId: "host",
        commandProfiles: [],
        worktrees: [
          {
            id: "worktree",
            name: "worktree",
            repositoryId: "repo",
            path: "/repo/worktree",
            labels: [],
          },
        ],
      }),
    ).resolves.toEqual({ ok: true, connectionId: "connection" });
    await expect(ctx.storage.getHostLock("host")).resolves.toBe("connection");
    await expect(
      handleHostMessageDurable(
        new ControlPlane({ storage: ctx.storage, connectionIdFactory: () => "replacement" }).state,
        {
          type: "host:register",
          hostId: "host",
          commandProfiles: [],
          worktrees: [],
        },
      ),
    ).resolves.toEqual({ ok: false, error: "hostId host already has an active connection" });
  });

  it("gives legacy schedules without a concurrency key their stable default", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ now: () => now, idFactory: () => "scheduled" });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      id: "legacy-schedule",
      repositoryId: "repo",
      name: "legacy",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: now,
    });
    delete plane.state.schedules.get(schedule.id)!.concurrencyId;

    const result = plane.triggerSchedule(schedule.id, now);
    expect(result).toMatchObject({ ok: true, created: true });
    expect(result.ok && result.session.concurrencyId).toBe("schedule-legacy-schedule");
  });
});
