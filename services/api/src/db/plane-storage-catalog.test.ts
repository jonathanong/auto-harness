import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import {
  getHostInventory,
  tryClaimScheduleAndCreateSession,
  updateScheduleManagement,
} from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx, ScheduleRecord } from "./plane-storage-types.ts";

function schedule(ref?: string): ScheduleRecord {
  return {
    id: "schedule-1",
    repositoryId: "repo-1",
    name: "schedule",
    target: { commandId: "command-1" },
    fallbacks: [],
    targetLabels: ["command"],
    cron: "* * * * *",
    enabled: true,
    timeout: 30,
    queueTtlSeconds: 60,
    nextRunAt: "stale-next",
    lastRunAt: "stale-last",
    createdAt: "created",
    ...(ref === undefined ? {} : { ref }),
  };
}

function scheduleCtx(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { schedules: "Schedules", concurrencyLocks: "Locks" } as never,
  };
}

describe("durable schedule creation", () => {
  it("reads host inventory strongly consistently after UI mutations", async () => {
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(GetCommand);
          expect((command as GetCommand).input).toMatchObject({
            TableName: "HostInventories",
            Key: { hostId: "host-1" },
            ConsistentRead: true,
          });
          return { Item: { hostId: "host-1", repositories: [], commandProfiles: {} } };
        },
      } as never,
      tables: { hostInventories: "HostInventories" } as never,
    };

    await expect(getHostInventory(ctx, "host-1")).resolves.toMatchObject({ hostId: "host-1" });
  });

  it("does not treat a failed schedule-cursor condition as a concurrency duplicate", async () => {
    let calls = 0;
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          calls += 1;
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "ConditionalCheckFailed" },
              { Code: "None" },
              { Code: "None" },
            ],
          };
        },
      } as never,
      tables: {
        sessions: "Sessions",
        worktrees: "Worktrees",
        concurrencyLocks: "ConcurrencyLocks",
        schedules: "Schedules",
      } as never,
    };

    await expect(
      tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "2026-01-01T00:00:00.000Z",
        newNextRunAt: "2026-01-01T00:01:00.000Z",
        lastRunAt: "2026-01-01T00:00:00.000Z",
        session: {
          id: "session-1",
          repositoryId: "repo-1",
          prompt: "scheduled",
          commandId: "command-1",
          targetLabel: "command",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          status: "queued",
          queueShard: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          concurrencyId: "schedule-1",
        },
      }),
    ).resolves.toEqual({ kind: "lost" });
    expect(calls).toBe(1);
  });
});

describe("durable schedule management updates", () => {
  it("updates operator fields without replacing a cron-advanced cursor", async () => {
    const storage = scheduleCtx(async (command) => {
      expect(command).toBeInstanceOf(UpdateCommand);
      const input = (command as UpdateCommand).input;
      expect(input.UpdateExpression).toContain("nextRunAt = :nextRunAt");
      expect(input.UpdateExpression).not.toContain("lastRunAt");
      expect(input.ConditionExpression).toContain("nextRunAt = :expectedNextRunAt");
      expect(input.UpdateExpression).toContain("#ref = :ref");
      expect(input.UpdateExpression).toContain("concurrencyId = :concurrencyId");
      return {
        Attributes: { ...schedule("main"), nextRunAt: "fresh-next", lastRunAt: "fresh-last" },
      };
    });

    await expect(
      updateScheduleManagement(
        storage,
        { ...schedule("main"), concurrencyId: "schedule-1" },
        "old-next",
      ),
    ).resolves.toMatchObject({ nextRunAt: "fresh-next", lastRunAt: "fresh-last" });
  });

  it("removes an omitted ref and reports a concurrently deleted schedule", async () => {
    const storage = scheduleCtx(async (command) => {
      expect((command as UpdateCommand).input.UpdateExpression).toContain(
        "REMOVE #ref, concurrencyId",
      );
      throw { name: "ConditionalCheckFailedException" };
    });

    await expect(updateScheduleManagement(storage, schedule(), "old-next")).resolves.toBeNull();
  });

  it("reads the committed schedule consistently after a marker-guarded update", async () => {
    const storage = scheduleCtx(async (command) => {
      if (command instanceof TransactWriteCommand) return {};
      expect(command).toBeInstanceOf(GetCommand);
      expect((command as GetCommand).input.ConsistentRead).toBe(true);
      return { Item: schedule() };
    });
    await expect(
      updateScheduleManagement(storage, schedule(), "old-next", [
        { key: "command:command-1", now: "now" },
      ]),
    ).resolves.toMatchObject({ id: "schedule-1" });
  });

  it("propagates storage failures", async () => {
    await expect(
      updateScheduleManagement(
        scheduleCtx(async () => Promise.reject(new Error("write failed"))),
        schedule(),
        "old-next",
      ),
    ).rejects.toThrow("write failed");
  });
});
