/* eslint-disable max-lines */
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { SESSION_LOGS_TTL_SECONDS } from "./dynamo.ts";
import {
  getHostInventory,
  deleteSchedule,
  disableLegacyFallbackScheduleAndAudit,
  listLogs,
  listSchedules,
  putLog,
  putLogFenced,
  putLogsFenced,
  putSchedule,
  setRepositoryAdmissionState,
  skipScheduleBeforeActivationCutoff,
  skipScheduleForClosedRepository,
  skipOwnerlessScheduleAndAudit,
  skipScheduleForPrincipalDrainAndAudit,
  tryClaimScheduleAndCreateSession,
  updateScheduleManagement,
  claimArchiveRetry,
  completeArchiveRetry,
  listPendingArchives,
  releaseArchiveRetry,
} from "./plane-storage-catalog.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import type { PlaneStorageCtx, ScheduleRecord } from "./plane-storage-types.ts";

const archive = {
  key: "sessions/session/logs.jsonl",
  contentType: "application/x-ndjson",
  bodyBytes: 5,
  status: "pending" as const,
  objectStored: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  retryState: "processing" as const,
  retryOrder: "2026-01-01T00:00:00.000Z#sessions/session/logs.jsonl",
};

function archiveCtx(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return { doc: { send } as never, tables: { archives: "Archives" } as never };
}

function schedule(ref?: string): ScheduleRecord {
  return {
    id: "schedule-1",
    repositoryId: "repo-1",
    name: "schedule",
    target: { commandId: "command-1" },
    fallbacks: [],
    targetDisplayNames: ["command"],
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

describe("archive retry storage", () => {
  it("lists the oldest pending and stale-processing rows through the retry index", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ ...archive, retryState: "pending", retryOrder: "2026-01-02#pending" }],
      })
      .mockResolvedValueOnce({
        Items: [{ ...archive, retryOrder: "2026-01-01#processing" }],
      });

    await expect(listPendingArchives(archiveCtx(send), 100)).resolves.toEqual([
      expect.objectContaining({ retryOrder: "2026-01-01#processing" }),
      expect.objectContaining({ retryOrder: "2026-01-02#pending" }),
    ]);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        TableName: "Archives",
        IndexName: "retryState-retryOrder",
        KeyConditionExpression: "retryState = :pending",
        Limit: 25,
        ScanIndexForward: true,
      },
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: {
        KeyConditionExpression: "retryState = :processing AND retryOrder < :staleBefore",
        ExpressionAttributeValues: expect.objectContaining({ ":processing": "processing" }),
      },
    });
  });

  it("bounds archive retry listing to at least one result", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await expect(listPendingArchives(archiveCtx(send), 0)).resolves.toEqual([]);
    expect(send.mock.calls).toHaveLength(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { Limit: 1 } });
  });

  it("handles missing retry-index pages and orders legacy rows by key", async () => {
    const missing = vi.fn().mockResolvedValue({});
    await expect(listPendingArchives(archiveCtx(missing), 1)).resolves.toEqual([]);

    const legacy = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ ...archive, key: "sessions/z/logs.jsonl", retryOrder: undefined }],
      })
      .mockResolvedValueOnce({
        Items: [{ ...archive, key: "sessions/a/logs.jsonl", retryOrder: undefined }],
      });
    await expect(listPendingArchives(archiveCtx(legacy), 2)).resolves.toEqual([
      expect.objectContaining({ key: "sessions/a/logs.jsonl" }),
      expect.objectContaining({ key: "sessions/z/logs.jsonl" }),
    ]);
  });

  it("claims, releases, and completes archive retry fences", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ctx = archiveCtx(send);

    await expect(
      claimArchiveRetry(ctx, archive.key, "pending", "pending-order", "claimed-order"),
    ).resolves.toBe(true);
    await expect(
      releaseArchiveRetry(ctx, archive.key, "claimed-order", "pending-order"),
    ).resolves.toBe(true);
    await expect(completeArchiveRetry(ctx, archive, "claimed-order")).resolves.toBe(true);
    await expect(
      completeArchiveRetry(
        ctx,
        { ...archive, objectKey: "archives/session.jsonl" },
        "claimed-order",
      ),
    ).resolves.toBe(true);

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        UpdateExpression: "SET retryState = :processing, retryOrder = :claimed",
        ExpressionAttributeValues: expect.objectContaining({ ":expectedState": "pending" }),
      },
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: { UpdateExpression: "SET retryState = :pending, retryOrder = :retryOrder" },
    });
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      input: { UpdateExpression: expect.stringContaining("REMOVE retryState, retryOrder") },
    });
    expect(send.mock.calls[3]?.[0]).toMatchObject({
      input: {
        UpdateExpression: expect.stringContaining("objectKey = :objectKey"),
        ExpressionAttributeValues: expect.objectContaining({
          ":objectKey": "archives/session.jsonl",
        }),
      },
    });
  });

  it("returns false when another worker changes an archive retry fence", async () => {
    const send = vi.fn().mockRejectedValue({ name: "ConditionalCheckFailedException" });
    const ctx = archiveCtx(send);

    await expect(
      claimArchiveRetry(ctx, archive.key, "processing", "claimed-order", "new-claim"),
    ).resolves.toBe(false);
    await expect(
      releaseArchiveRetry(ctx, archive.key, "claimed-order", "pending-order"),
    ).resolves.toBe(false);
    await expect(completeArchiveRetry(ctx, archive, "claimed-order")).resolves.toBe(false);
  });

  it("propagates non-conditional archive retry failures", async () => {
    const ctx = archiveCtx(vi.fn().mockRejectedValue(new Error("archive retry unavailable")));
    await expect(
      claimArchiveRetry(ctx, archive.key, "pending", "pending-order", "claimed-order"),
    ).rejects.toThrow("archive retry unavailable");
    await expect(
      releaseArchiveRetry(ctx, archive.key, "claimed-order", "pending-order"),
    ).rejects.toThrow("archive retry unavailable");
    await expect(completeArchiveRetry(ctx, archive, "claimed-order")).rejects.toThrow(
      "archive retry unavailable",
    );
  });
});

describe("archive and assignment base-storage delegators", () => {
  it("forwards bounded migrations, timeout cleanup, lease repair, and archive retry operations", async () => {
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      const { input } = command;
      if (input.TableName === "SessionDrains" && input.UpdateExpression === undefined) return {};
      if (input.UpdateExpression?.toString().includes("ADD fence")) {
        return { Attributes: { fence: 1 } };
      }
      if (input.TableName === "Archives" && input.ConsistentRead) return { Items: [] };
      if (input.IndexName === "retryState-retryOrder") return { Items: [] };
      return {};
    });
    const storage = new DynamoPlaneStorageBase(
      { send } as never,
      {
        archives: "Archives",
        sessionDrains: "SessionDrains",
        sessions: "Sessions",
        concurrencyLocks: "Locks",
        hostLocks: "Hosts",
        providerAccounts: "Accounts",
      } as never,
    );

    await expect(storage.migrateArchiveRetryIndexPage()).resolves.toBe(true);
    await expect(
      storage.releaseTimedOutProviderAccountLease({
        concurrencyId: "provider-lease:account:0",
        sessionId: "session",
        attemptId: "attempt",
      }),
    ).resolves.toBe(true);
    await expect(
      storage.releaseTimedOutHostAssignment({
        sessionId: "session",
        attemptId: "attempt",
        hostId: "host",
      }),
    ).resolves.toBe(true);
    await expect(
      storage.backfillProviderAccountLease({
        sessionId: "session",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "account",
        slot: 0,
      }),
    ).resolves.toMatchObject({ status: "migrated" });
    await expect(storage.listPendingArchives(1)).resolves.toEqual([]);
    await expect(
      storage.claimArchiveRetry(archive.key, "pending", "pending-order", "claimed-order"),
    ).resolves.toBe(true);
    await expect(
      storage.releaseArchiveRetry(archive.key, "claimed-order", "pending-order"),
    ).resolves.toBe(true);
    await expect(storage.completeArchiveRetry(archive, "claimed-order")).resolves.toBe(true);
    expect(send).toHaveBeenCalled();
  });
});

describe("repository admission storage", () => {
  it("fences a non-reopening activation to active or legacy rows", async () => {
    let input: UpdateCommand["input"] | undefined;
    const storage = scheduleCtx(async (command) => {
      input = (command as UpdateCommand).input;
      return { Attributes: { id: "repo-1", admissionState: "active" } };
    });

    await expect(
      setRepositoryAdmissionState(storage, "repo-1", "active", "2026-01-01T00:00:00.000Z"),
    ).resolves.toMatchObject({ admissionState: "active" });

    expect(input).toMatchObject({
      ConditionExpression:
        "attribute_exists(id) AND (attribute_not_exists(#state) OR #state = :active)",
      ExpressionAttributeNames: { "#state": "admissionState" },
      ExpressionAttributeValues: {
        ":active": "active",
      },
    });
    expect(input?.ExpressionAttributeValues).not.toHaveProperty(":draining");
  });
});

describe("durable schedule creation", () => {
  it("allows eventually consistent schedule scans when requested", async () => {
    let input: unknown;
    const storage = scheduleCtx(async (command) => {
      input = (command as { input: unknown }).input;
      return { Items: [] };
    });

    await expect(listSchedules(storage, false)).resolves.toEqual([]);
    expect(input).toEqual({ TableName: "Schedules" });
  });

  it("does not build an over-limit transaction for legacy fallback-heavy schedules", async () => {
    let calls = 0;
    const storage = scheduleCtx(async () => {
      calls += 1;
      return {};
    });

    await expect(
      tryClaimScheduleAndCreateSession(storage, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        lastRunAt: "now",
        session: {
          id: "legacy-fallback-session",
          repositoryId: "repo-1",
          principalId: "principal-1",
          prompt: "scheduled",
          target: { commandId: "command-1" },
          fallbacks: Array.from({ length: 91 }, (_, index) => ({
            commandId: `legacy-${index}`,
          })),
          targetDisplayNames: [],
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
    ).resolves.toEqual({ kind: "legacy_fallbacks", fallbackCount: 91 });
    expect(calls).toBe(0);
  });

  it("audits and disables a legacy fallback-heavy schedule atomically", async () => {
    let input: TransactWriteCommandInput | undefined;
    const storage = scheduleCtx(async (command) => {
      input = (command as TransactWriteCommand).input;
      return {};
    });

    await expect(
      disableLegacyFallbackScheduleAndAudit(storage, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        audit: {
          id: "audit-legacy-fallbacks",
          createdAt: "now",
          actor: { id: "system", kind: "system", role: "system" },
          action: "schedule:legacy-fallbacks-disabled",
          resourceType: "schedule",
          resourceId: "schedule-1",
          repositoryId: "repo-1",
          outcome: "failed",
          metadata: {},
        },
      }),
    ).resolves.toBe(true);
    expect(input?.TransactItems).toEqual([
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "Schedules",
          Key: { id: "schedule-1" },
          UpdateExpression: "SET enabled = :false",
          ConditionExpression:
            "nextRunAt = :expectedNextRunAt AND enabled = :true AND size(fallbacks) > :maxFallbacks",
          ExpressionAttributeValues: expect.objectContaining({ ":maxFallbacks": 90 }),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: "AuditLogs",
          Item: expect.objectContaining({ id: "audit-legacy-fallbacks" }),
        }),
      }),
    ]);
  });

  it("returns false when the legacy schedule migration loses its cursor", async () => {
    const storage = scheduleCtx(async () => {
      throw { name: "ConditionalCheckFailedException" };
    });
    await expect(
      disableLegacyFallbackScheduleAndAudit(storage, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        audit: {
          id: "audit-legacy-fallbacks-lost",
          createdAt: "now",
          actor: { id: "system", kind: "system", role: "system" },
          action: "schedule:legacy-fallbacks-disabled",
          resourceType: "schedule",
          resourceId: "schedule-1",
          repositoryId: "repo-1",
          outcome: "failed",
          metadata: {},
        },
      }),
    ).resolves.toBe(false);
  });

  it("rethrows unexpected legacy schedule migration failures", async () => {
    const error = new Error("Dynamo unavailable");
    const storage = scheduleCtx(async () => {
      throw error;
    });
    await expect(
      disableLegacyFallbackScheduleAndAudit(storage, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        audit: {
          id: "audit-legacy-fallbacks-error",
          createdAt: "now",
          actor: { id: "system", kind: "system", role: "system" },
          action: "schedule:legacy-fallbacks-disabled",
          resourceType: "schedule",
          resourceId: "schedule-1",
          repositoryId: "repo-1",
          outcome: "failed",
          metadata: {},
        },
      }),
    ).rejects.toBe(error);
  });

  it("keeps owned schedule deletion behind its live principal marker", async () => {
    let input: TransactWriteCommandInput | undefined;
    const storage = scheduleCtx(async (command) => {
      input = (command as TransactWriteCommand).input;
      return {};
    });

    await deleteSchedule(storage, "schedule-1", [
      { key: "principal:principal-1", owner: "delete-owner", now: "now" },
    ]);

    expect(input?.TransactItems).toEqual([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: { concurrencyId: "catalog-delete:principal:principal-1" },
          ExpressionAttributeValues: { ":owner": "delete-owner", ":now": "now" },
        }),
      }),
      expect.objectContaining({ Delete: { TableName: "Schedules", Key: { id: "schedule-1" } } }),
    ]);
  });

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
        activationCutoffAt: "1970-01-01T00:00:00.002Z",
        expectedNextRunAtEpochMs: 1,
        session: {
          id: "session-activity",
          repositoryId: "repo-1",
          metadata: { createdBy: "principal" },
          prompt: "scheduled",
          target: { commandId: "command-1" },
          fallbacks: [],
          targetDisplayNames: ["command"],
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
    expect(input?.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "Users",
            Key: { id: "principal" },
            ConditionExpression: "attribute_exists(id)",
          }),
        }),
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "Locks",
            Key: { concurrencyId: "catalog-delete:repository:repo-1" },
          }),
        }),
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "Locks",
            Key: { concurrencyId: "catalog-delete:principal:principal" },
          }),
        }),
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "Locks",
            Key: { concurrencyId: "catalog-delete:command:command-1" },
          }),
        }),
      ]),
    );
    expect(input?.TransactItems?.[0]?.Update?.ConditionExpression).toContain(
      ":expectedNextRunAtEpochMs >= :activationCutoffEpochMs",
    );
    expect(input?.TransactItems).toContainEqual(
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          TableName: "Repositories",
          ConditionExpression: expect.stringContaining("activationCutoffAt = :activationCutoffAt"),
        }),
      }),
    );
  });

  it("does not advance the schedule cursor when an admission marker is lost", async () => {
    let calls = 0;
    const storage = scheduleCtx(async (command) => {
      calls += 1;
      expect(command).toBeInstanceOf(TransactWriteCommand);
      throw {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" },
          { Code: "None" },
          { Code: "None" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
        ],
      };
    });
    await expect(
      tryClaimScheduleAndCreateSession(storage, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        lastRunAt: "now",
        session: {
          id: "session-marker-race",
          repositoryId: "repo-1",
          principalId: "principal",
          prompt: "scheduled",
          target: { commandId: "command-1" },
          fallbacks: [],
          targetDisplayNames: ["command"],
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
    ).resolves.toEqual({ kind: "lost" });
    expect(calls).toBe(1);
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
          targetDisplayNames: ["command"],
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

  it("does not claim a schedule when its principal no longer exists", async () => {
    const ctx = scheduleCtx(async () => {
      throw {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
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
          id: "session-principal-race",
          repositoryId: "repo-1",
          principalId: "principal",
          prompt: "scheduled",
          target: { commandId: "command-1" },
          fallbacks: [],
          targetDisplayNames: ["command"],
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
    ).resolves.toEqual({ kind: "lost" });
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
          targetDisplayNames: ["command"],
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
  it("fences a stale occurrence to the active repository cutover", async () => {
    let input: TransactWriteCommandInput | undefined;
    const storage = scheduleCtx(async (command) => {
      input = (command as TransactWriteCommand).input;
      return {};
    });

    await expect(
      skipScheduleBeforeActivationCutoff(storage, {
        scheduleId: "schedule-1",
        repositoryId: "repo-1",
        activationCutoffAt: "2026-01-01T00:30:00.000Z",
        expectedNextRunAt: "2026-01-01T01:00:00+01:00",
        newNextRunAt: "2026-01-01T00:03:00.000Z",
      }),
    ).resolves.toBe(true);
    const [scheduleItem, repository] = input?.TransactItems ?? [];
    expect(scheduleItem?.Update?.ConditionExpression).toContain(
      ":expectedNextRunAtEpochMs < :activationCutoffEpochMs",
    );
    expect(scheduleItem?.Update?.ExpressionAttributeValues).toMatchObject({
      ":repositoryId": "repo-1",
      ":expectedNextRunAtEpochMs": Date.parse("2026-01-01T01:00:00+01:00"),
      ":activationCutoffEpochMs": Date.parse("2026-01-01T00:30:00.000Z"),
    });
    expect(repository?.ConditionCheck?.ConditionExpression).toContain(
      "activationCutoffAt = :activationCutoffAt",
    );

    const rejected = scheduleCtx(async () => {
      throw { name: "ConditionalCheckFailedException" };
    });
    await expect(
      skipScheduleBeforeActivationCutoff(rejected, {
        scheduleId: "schedule-1",
        repositoryId: "repo-1",
        activationCutoffAt: "2026-01-01T00:02:00.000Z",
        expectedNextRunAt: "2026-01-01T00:01:00.000Z",
        newNextRunAt: "2026-01-01T00:03:00.000Z",
      }),
    ).resolves.toBe(false);
  });

  it("binds closed schedule cursor CAS to the schedule repository", async () => {
    let input: TransactWriteCommandInput | undefined;
    const storage = scheduleCtx(async (command) => {
      input = (command as TransactWriteCommand).input;
      return {};
    });

    await expect(
      skipScheduleForClosedRepository(storage, {
        scheduleId: "schedule-1",
        repositoryId: "repo-1",
        expectedNextRunAt: "old-next",
        newNextRunAt: "new-next",
      }),
    ).resolves.toBe(true);
    const update = input?.TransactItems?.[0]?.Update;
    expect(update?.ConditionExpression).toContain("repositoryId = :repositoryId");
    expect(update?.ExpressionAttributeValues).toMatchObject({ ":repositoryId": "repo-1" });
  });

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
        "REMOVE targetLabels, #ref, concurrencyId",
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

describe("session log ttl", () => {
  it("stamps seven-day epoch ttl on single, fenced, and batched writes", async () => {
    const items: Array<Record<string, unknown> | undefined> = [];
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof PutCommand) items.push(command.input.Item);
          if (command instanceof TransactWriteCommand) {
            for (const action of command.input.TransactItems ?? []) {
              items.push(action.Put?.Item);
            }
          }
          return {};
        },
      } as never,
      tables: {
        sessionLogs: "SessionLogs",
        hostLocks: "HostLocks",
      } as never,
    };
    const rec = {
      sessionId: "session-1",
      timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      stream: "stdout",
      content: "line",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    };
    const before = Date.now();
    await putLog(ctx, rec);
    await putLogFenced(ctx, rec, { hostId: "host", connectionId: "connection" });
    await putLogsFenced(ctx, [rec, rec], { hostId: "host", connectionId: "connection" });
    const after = Date.now();
    const written = items.filter((item): item is Record<string, unknown> => item !== undefined);
    expect(written).toHaveLength(3);
    for (const item of written) {
      expect(item.ttl).toBeGreaterThanOrEqual(Math.floor(before / 1000) + SESSION_LOGS_TTL_SECONDS);
      expect(item.ttl).toBeLessThanOrEqual(Math.floor(after / 1000) + SESSION_LOGS_TTL_SECONDS);
    }
  });

  it("overwrites a caller-supplied ttl on single, fenced, and batched writes", async () => {
    const items: Array<Record<string, unknown> | undefined> = [];
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof PutCommand) items.push(command.input.Item);
          if (command instanceof TransactWriteCommand) {
            for (const action of command.input.TransactItems ?? []) {
              items.push(action.Put?.Item);
            }
          }
          return {};
        },
      } as never,
      tables: {
        sessionLogs: "SessionLogs",
        hostLocks: "HostLocks",
      } as never,
    };
    const rec = {
      sessionId: "session-1",
      timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      stream: "stdout",
      content: "line",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
      ttl: 1,
    };
    const before = Date.now();
    await putLog(ctx, rec);
    await putLogFenced(ctx, rec, { hostId: "host", connectionId: "connection" });
    await putLogsFenced(
      ctx,
      [
        rec,
        {
          ...rec,
          timestampSeq: "2026-01-01T00:00:00.000Z#0000000002",
          seq: 2,
          ttl: Date.now(),
        },
      ],
      { hostId: "host", connectionId: "connection" },
    );
    const after = Date.now();
    const written = items.filter((item): item is Record<string, unknown> => item !== undefined);
    expect(written).toHaveLength(4);
    for (const item of written) {
      expect(item.ttl).not.toBe(1);
      expect(item.ttl).toBeGreaterThanOrEqual(Math.floor(before / 1000) + SESSION_LOGS_TTL_SECONDS);
      expect(item.ttl).toBeLessThanOrEqual(Math.floor(after / 1000) + SESSION_LOGS_TTL_SECONDS);
    }
  });

  it("conditions fenced log writes on the session attempt", async () => {
    const commands: TransactWriteCommand[] = [];
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) commands.push(command);
          return {};
        },
      } as never,
      tables: {
        sessionLogs: "SessionLogs",
        hostLocks: "HostLocks",
        sessions: "Sessions",
      } as never,
    };
    const rec = {
      sessionId: "session-1",
      timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      stream: "stdout",
      content: "line",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    };
    expect(
      await putLogsFenced(ctx, [rec], {
        hostId: "host",
        connectionId: "connection",
        attempts: [
          { sessionId: "session-1", attemptId: "a" },
          { sessionId: "session-1", attemptId: "b" },
        ],
      }),
    ).toBe(false);
    expect(
      await putLogFenced(ctx, rec, {
        hostId: "host",
        connectionId: "connection",
        attempts: [
          { sessionId: "session-1", attemptId: "a" },
          { sessionId: "session-1", attemptId: "b" },
        ],
      }),
    ).toBe(false);
    expect(commands).toEqual([]);
    expect(
      await putLogFenced(ctx, rec, {
        hostId: "host",
        connectionId: "connection",
        attempts: [
          { sessionId: "session-1", attemptId: "attempt-1" },
          { sessionId: "session-1", attemptId: "attempt-1" },
        ],
      }),
    ).toBe(true);
    commands.length = 0;
    expect(
      await putLogFenced(ctx, rec, {
        hostId: "host",
        connectionId: "connection",
        attempts: [{ sessionId: "session-1", attemptId: "attempt-1" }],
      }),
    ).toBe(true);
    expect(
      await putLogsFenced(
        ctx,
        [rec, { ...rec, seq: 2, timestampSeq: "2026-01-01T00:00:00.000Z#0000000002" }],
        {
          hostId: "host",
          connectionId: "connection",
          attempts: [
            { sessionId: "session-1", attemptId: "attempt-1" },
            { sessionId: "session-2", attemptId: "attempt-2" },
          ],
        },
      ),
    ).toBe(true);
    expect(commands[0]?.input.TransactItems).toEqual(
      expect.arrayContaining([
        {
          ConditionCheck: {
            TableName: "HostLocks",
            Key: { hostId: "host" },
            ConditionExpression: "connectionId = :connectionId",
            ExpressionAttributeValues: { ":connectionId": "connection" },
          },
        },
        {
          ConditionCheck: {
            TableName: "Sessions",
            Key: { id: "session-1" },
            ConditionExpression: "attemptId = :attemptId",
            ExpressionAttributeValues: { ":attemptId": "attempt-1" },
          },
        },
      ]),
    );
    expect(
      commands[1]?.input.TransactItems?.filter(
        (item) => item.ConditionCheck?.TableName === "Sessions",
      ),
    ).toEqual([
      {
        ConditionCheck: {
          TableName: "Sessions",
          Key: { id: "session-1" },
          ConditionExpression: "attemptId = :attemptId",
          ExpressionAttributeValues: { ":attemptId": "attempt-1" },
        },
      },
      {
        ConditionCheck: {
          TableName: "Sessions",
          Key: { id: "session-2" },
          ConditionExpression: "attemptId = :attemptId",
          ExpressionAttributeValues: { ":attemptId": "attempt-2" },
        },
      },
    ]);
  });
});

describe("session log read consistency", () => {
  it("reads eventually consistent by default and strongly consistent on request", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return { Items: [] };
    });
    const ctx: PlaneStorageCtx = {
      doc: { send } as never,
      tables: { sessionLogs: "SessionLogs" } as never,
    };

    await listLogs(ctx, "session-1");
    expect((send.mock.calls[0]![0] as QueryCommand).input.ConsistentRead).toBeUndefined();

    await listLogs(ctx, "session-1", true);
    expect((send.mock.calls[1]![0] as QueryCommand).input.ConsistentRead).toBe(true);
  });
});
