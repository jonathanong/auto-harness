/* eslint-disable max-lines */
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import {
  getHostInventory,
  putSchedule,
  skipOwnerlessScheduleAndAudit,
  skipScheduleForPrincipalDrainAndAudit,
  tryClaimScheduleAndCreateSession,
  updateScheduleManagement,
} from "./plane-storage-catalog.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
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
    tables: {
      schedules: "Schedules",
      auditLogs: "AuditLogs",
      concurrencyLocks: "Locks",
      repositories: "Repositories",
      sessionDrains: "SessionDrains",
      users: "Users",
    } as never,
  };
}

describe("durable schedule creation", () => {
  it("requires a durable user for principal-owned schedules only", async () => {
    const commands: unknown[] = [];
    const storage = scheduleCtx(async (command) => {
      commands.push(command);
      return {};
    });

    await putSchedule(storage, { ...schedule(), principalId: "principal-1" });
    await putSchedule(storage, { ...schedule(), id: "system", principalId: "system" });
    await putSchedule(storage, { ...schedule(), id: "ownerless" });

    expect((commands[0] as TransactWriteCommand).input.TransactItems).toEqual(
      expect.arrayContaining([
        {
          ConditionCheck: {
            TableName: "Users",
            Key: { id: "principal-1" },
            ConditionExpression: "attribute_exists(id)",
          },
        },
      ]),
    );
    expect(commands.slice(1)).toEqual([expect.any(PutCommand), expect.any(PutCommand)]);
  });

  it("registers the scheduled session ACT member in the cursor/admission transaction", async () => {
    let input: TransactWriteCommandInput | undefined;
    const storage = scheduleCtx(async (command) => {
      input = (command as TransactWriteCommand).input;
      return {};
    });

    await expect(
      tryClaimScheduleAndCreateSession(storage, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        lastRunAt: "one",
        session: {
          id: "session-activity",
          repositoryId: "repo-1",
          metadata: { createdBy: "principal" },
          prompt: "scheduled",
          target: { commandId: "command-1" },
          fallbacks: [],
          targetLabels: ["command"],
          queueTtlSeconds: 60,
          queueExpiresAt: "later",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          status: "queued",
          queueShard: 0,
          createdAt: "now",
          concurrencyId: "schedule-1",
        },
      }),
    ).resolves.toEqual({ kind: "created" });

    expect(input?.TransactItems).toContainEqual(
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: "SessionDrains",
          Item: expect.objectContaining({
            scopeKey: "repo-1#principal",
            recordKey: "ACT#session-activity",
          }),
        }),
      }),
    );
  });

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

  it("reports a repository admission fence loss", async () => {
    const ctx = scheduleCtx(async () => {
      throw {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
        ],
      };
    });
    await expect(
      tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        lastRunAt: "one",
        session: {
          id: "session-1",
          repositoryId: "repo-1",
          prompt: "scheduled",
          target: { commandId: "command-1" },
          fallbacks: [],
          targetLabels: ["command"],
          queueTtlSeconds: 60,
          queueExpiresAt: "later",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          status: "queued",
          queueShard: 0,
          createdAt: "now",
        },
      }),
    ).resolves.toEqual({ kind: "admission_closed" });
  });

  it("reports an unknown drain when its fence wins before the follow-up read", async () => {
    const ctx = scheduleCtx(async (command) => {
      if (command instanceof GetCommand) return {};
      throw {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      };
    });
    await expect(
      tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        lastRunAt: "one",
        session: {
          id: "session-1",
          repositoryId: "repo-1",
          principalId: "principal",
          prompt: "scheduled",
          target: { commandId: "command-1" },
          fallbacks: [],
          targetLabels: ["command"],
          queueTtlSeconds: 60,
          queueExpiresAt: "later",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          status: "queued",
          queueShard: 0,
          createdAt: "now",
        },
      }),
    ).resolves.toEqual({ kind: "draining", operationId: "unknown" });
  });
});

describe("durable schedule management updates", () => {
  it("rejects a schedule update that exceeds DynamoDB's transaction action limit", async () => {
    const ctx = scheduleCtx(async () => {
      throw new Error("must not write");
    });
    const markers = Array.from({ length: 100 }, (_, index) => ({
      key: `marker:${index}`,
      now: "now",
    }));

    await expect(updateScheduleManagement(ctx, schedule(), "stale-next", markers)).rejects.toThrow(
      "catalog reference write exceeds DynamoDB's 100 transaction action limit",
    );
  });

  it("couples ownerless and drain skips with their audit records", async () => {
    const writes: TransactWriteCommandInput[] = [];
    const ctx = scheduleCtx(async (command) => {
      writes.push((command as TransactWriteCommand).input);
      return {};
    });
    const audit = {
      id: "audit-1",
      createdAt: "now",
      actor: { id: "system", kind: "system" as const, role: "system" as const },
      action: "schedule:ownerless-occurrence-skipped",
      resourceType: "schedule",
      resourceId: "schedule-1",
      repositoryId: "repo-1",
      outcome: "failed" as const,
      metadata: { reason: "ownerless" },
    };

    await expect(
      skipOwnerlessScheduleAndAudit(ctx, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        lastRunAt: "now",
        audit,
      }),
    ).resolves.toBe(true);
    await expect(
      skipScheduleForPrincipalDrainAndAudit(ctx, {
        scheduleId: "schedule-1",
        repositoryId: "repo-1",
        principalId: "principal-1",
        operationId: "drain-1",
        expectedNextRunAt: "two",
        newNextRunAt: "three",
        audit: { ...audit, id: "audit-2", action: "session-drain:admission-rejected" },
      }),
    ).resolves.toBe(true);

    expect(writes[0]?.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            ConditionExpression: expect.stringContaining("attribute_not_exists(principalId)"),
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            TableName: "AuditLogs",
            Item: expect.objectContaining({ scope: "audit", id: "audit-1" }),
          }),
        }),
      ]),
    );
    expect(writes[1]?.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({ TableName: "SessionDrains" }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            TableName: "AuditLogs",
            Item: expect.objectContaining({ scope: "audit", id: "audit-2" }),
          }),
        }),
      ]),
    );
    const update = writes[1]?.TransactItems?.find((item) => item.Update)?.Update;
    expect(update).toMatchObject({
      ConditionExpression: expect.stringContaining("repositoryId = :repositoryId"),
      ExpressionAttributeValues: expect.objectContaining({
        ":repositoryId": "repo-1",
        ":principalId": "principal-1",
      }),
    });
  });

  it("advances a schedule only while its principal drain remains active", async () => {
    let active = true;
    const writes: TransactWriteCommandInput[] = [];
    const storage = new DynamoPlaneStorageBase(
      {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(TransactWriteCommand);
          writes.push((command as TransactWriteCommand).input);
          expect((command as TransactWriteCommand).input.TransactItems).toHaveLength(2);
          if (!active) {
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
            };
          }
          return {};
        },
      } as never,
      { schedules: "Schedules", sessionDrains: "SessionDrains" } as never,
    );

    await expect(
      storage.skipScheduleForPrincipalDrain({
        scheduleId: "schedule-1",
        repositoryId: "repo-1",
        principalId: "principal-1",
        operationId: "drain-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
      }),
    ).resolves.toBe(true);
    const update = writes[0]?.TransactItems?.find((item) => item.Update)?.Update;
    expect(update).toMatchObject({
      ConditionExpression: expect.stringContaining("repositoryId = :repositoryId"),
      ExpressionAttributeValues: expect.objectContaining({
        ":repositoryId": "repo-1",
        ":principalId": "principal-1",
      }),
    });
    active = false;
    await expect(
      storage.skipScheduleForPrincipalDrain({
        scheduleId: "schedule-1",
        repositoryId: "repo-1",
        principalId: "principal-1",
        operationId: "drain-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
      }),
    ).resolves.toBe(false);
  });

  it("updates operator fields without replacing a cron-advanced cursor", async () => {
    const storage = scheduleCtx(async (command) => {
      if (command instanceof GetCommand) {
        expect(command.input.ConsistentRead).toBe(true);
        return {
          Item: { ...schedule("main"), nextRunAt: "fresh-next", lastRunAt: "fresh-last" },
        };
      }
      expect(command).toBeInstanceOf(TransactWriteCommand);
      const input = (command as TransactWriteCommand).input;
      const update = input.TransactItems?.find((item) => item.Update)?.Update;
      expect(update?.UpdateExpression).toContain("nextRunAt = :nextRunAt");
      expect(update?.UpdateExpression).not.toContain("lastRunAt");
      expect(update?.ConditionExpression).toContain("nextRunAt = :expectedNextRunAt");
      expect(update?.ConditionExpression).toContain(
        "attribute_not_exists(principalId) OR principalId = :principalId",
      );
      expect(update?.UpdateExpression).toContain("#ref = :ref");
      expect(update?.UpdateExpression).toContain("concurrencyId = :concurrencyId");
      expect(update?.UpdateExpression).toContain("prompt = :prompt");
      expect(input.TransactItems).toContainEqual({
        ConditionCheck: {
          TableName: "Users",
          Key: { id: "principal" },
          ConditionExpression: "attribute_exists(id)",
        },
      });
      return {};
    });

    await expect(
      updateScheduleManagement(
        storage,
        {
          ...schedule("main"),
          concurrencyId: "schedule-1",
          prompt: "review the repo",
          principalId: "principal",
        },
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

  it("atomically refuses to clear ownership from an already-owned schedule", async () => {
    const storage = scheduleCtx(async (command) => {
      expect(command).toBeInstanceOf(UpdateCommand);
      expect((command as UpdateCommand).input.ConditionExpression).toContain(
        "attribute_not_exists(principalId)",
      );
      expect((command as UpdateCommand).input.ExpressionAttributeValues).not.toHaveProperty(
        ":principalId",
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
