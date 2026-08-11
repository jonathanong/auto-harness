import { describe, expect, it } from "vitest";

import { assignQueuedDurable } from "./control-plane-assign.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("durable control-plane core edge coverage", () => {
  it("persists a durable queue expiry before removing it from the assignment queue", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:10.000Z", shardCount: 1 });
    const expired: string[] = [];
    setDurableReadStorage(plane.state, {
      expireQueuedSession: async (input: { sessionId: string }) => {
        expired.push(input.sessionId);
        return true;
      },
    });
    plane.state.sessions.set("expired", {
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
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(assignQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(expired).toEqual(["expired"]);
    expect(plane.getSession("expired")).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });
  });

  it("keeps a rejected durable acknowledgement idempotently successful", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const session = {
      id: "session",
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
    plane.state.storage = {
      getSession: async () => session,
      acknowledgeSession: async () => false,
    } as never;

    await expect(
      handleHostMessageDurable(plane.state, {
        type: "session:ack",
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
      }),
    ).resolves.toEqual({ ok: true });
    expect(plane.getSession("session")?.ackReceivedAt).toBeUndefined();
  });

  it("acquires a non-replacing durable host lease for a first registration", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    const leaseRequests: Array<{ replaceExisting: boolean }> = [];
    plane.state.storage = {
      tryAcquireHostLock: async (request: { replaceExisting: boolean }) => {
        leaseRequests.push(request);
      },
      putConnection: async () => undefined,
      putHostInventory: async () => undefined,
      putWorktree: async () => undefined,
      listWorktreesByHost: async () => [],
    } as never;

    expect(
      plane.registerHost({
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
    ).toEqual({ ok: true, connectionId: "connection" });
    await plane.settleStorage();
    expect(leaseRequests).toEqual([expect.objectContaining({ replaceExisting: false })]);
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
