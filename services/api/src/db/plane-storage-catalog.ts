/* eslint-disable max-lines */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type HostInventoryRecord,
  type ArchiveObject,
  type LogRecord,
  type PlaneStorageCtx,
  type RepositoryRecord,
  type ScheduleRecord,
} from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";
import { sessionToItem } from "./plane-storage-types.ts";
import {
  getConcurrencyLock,
  getSession,
  releaseConcurrencyLock,
} from "./plane-storage-sessions.ts";

export async function putLog(ctx: PlaneStorageCtx, rec: LogRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessionLogs,
      Item: { ...rec },
    }),
  );
}

export async function putLogFenced(
  ctx: PlaneStorageCtx,
  rec: LogRecord,
  fence: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: fence.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": fence.connectionId },
            },
          },
          { Put: { TableName: ctx.tables.sessionLogs, Item: { ...rec } } },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

export async function deleteLog(
  ctx: PlaneStorageCtx,
  sessionId: string,
  timestampSeq: string,
): Promise<void> {
  await ctx.doc.send(
    new DeleteCommand({ TableName: ctx.tables.sessionLogs, Key: { sessionId, timestampSeq } }),
  );
}

export async function listLogs(ctx: PlaneStorageCtx, sessionId: string): Promise<LogRecord[]> {
  const res = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessionLogs,
      KeyConditionExpression: "sessionId = :s",
      ExpressionAttributeValues: { ":s": sessionId },
      ScanIndexForward: true,
    }),
  );
  return (res.Items ?? []) as LogRecord[];
}

export async function putSchedule(ctx: PlaneStorageCtx, rec: ScheduleRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.schedules,
      Item: { ...rec },
    }),
  );
}

export async function getSchedule(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<ScheduleRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.schedules, Key: { id } }));
  return (res.Item as ScheduleRecord | undefined) ?? null;
}

export async function listSchedules(ctx: PlaneStorageCtx): Promise<ScheduleRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.schedules }));
  return (res.Items ?? []) as ScheduleRecord[];
}

export async function deleteSchedule(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.schedules, Key: { id } }));
}

export async function putRepository(ctx: PlaneStorageCtx, rec: RepositoryRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.repositories,
      Item: { ...rec },
    }),
  );
}

export async function getRepository(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<RepositoryRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.repositories, Key: { id } }),
  );
  return (res.Item as RepositoryRecord | undefined) ?? null;
}

export async function listRepositories(ctx: PlaneStorageCtx): Promise<RepositoryRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.repositories }));
  return (res.Items ?? []) as RepositoryRecord[];
}

export async function deleteRepository(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.repositories, Key: { id } }));
}

/** Conditional nextRunAt advance (Invariant 4). */
export async function tryClaimSchedule(
  ctx: PlaneStorageCtx,
  scheduleId: string,
  expectedNextRunAt: string,
  newNextRunAt: string,
  lastRunAt: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.schedules,
        Key: { id: scheduleId },
        UpdateExpression: "SET nextRunAt = :n, lastRunAt = :l",
        ConditionExpression: "nextRunAt = :e AND enabled = :true",
        ExpressionAttributeValues: {
          ":n": newNextRunAt,
          ":l": lastRunAt,
          ":e": expectedNextRunAt,
          ":true": true,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * Claim a due schedule and insert its session in one DynamoDB transaction.
 * This is deliberately separate from `tryClaimSchedule`: advancing the cron
 * cursor without the corresponding session creates a silent missed run.
 */
export type ScheduleCreateResult =
  | { kind: "created" }
  | { kind: "duplicate"; session: SessionRecord }
  | { kind: "lost" };

export async function tryClaimScheduleAndCreateSession(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    lastRunAt: string;
    session: SessionRecord;
  },
): Promise<ScheduleCreateResult> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.schedules,
              Key: { id: opts.scheduleId },
              UpdateExpression: "SET nextRunAt = :n, lastRunAt = :l",
              ConditionExpression: "nextRunAt = :e AND enabled = :true",
              ExpressionAttributeValues: {
                ":n": opts.newNextRunAt,
                ":l": opts.lastRunAt,
                ":e": opts.expectedNextRunAt,
                ":true": true,
              },
            },
          },
          {
            Put: {
              TableName: ctx.tables.sessions,
              Item: sessionToItem(opts.session),
              ConditionExpression: "attribute_not_exists(id)",
            },
          },
          ...(opts.session.concurrencyId
            ? [
                {
                  Put: {
                    TableName: ctx.tables.concurrencyLocks,
                    Item: { concurrencyId: opts.session.concurrencyId, sessionId: opts.session.id },
                    ConditionExpression: "attribute_not_exists(concurrencyId)",
                  },
                },
              ]
            : []),
        ],
      }),
    );
    return { kind: "created" };
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      if (opts.session.concurrencyId) {
        const lock = await getConcurrencyLock(ctx, opts.session.concurrencyId);
        if (lock) {
          const current = await getSession(ctx, lock.sessionId);
          if (current && (current.status === "queued" || current.status === "running")) {
            return { kind: "duplicate", session: current };
          }
          await releaseConcurrencyLock(ctx, opts.session.concurrencyId, lock.sessionId);
        }
      }
      return { kind: "lost" };
    }
    throw err;
  }
}

/** Advance a due cron cursor after suppressing an already-active concurrent session. */
export async function skipScheduleForActiveConcurrency(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    concurrencyId: string;
    sessionId: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.schedules,
              Key: { id: opts.scheduleId },
              UpdateExpression: "SET nextRunAt = :nextRunAt",
              ConditionExpression: "nextRunAt = :expectedNextRunAt AND enabled = :true",
              ExpressionAttributeValues: {
                ":nextRunAt": opts.newNextRunAt,
                ":expectedNextRunAt": opts.expectedNextRunAt,
                ":true": true,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: ctx.tables.concurrencyLocks,
              Key: { concurrencyId: opts.concurrencyId },
              ConditionExpression: "sessionId = :sessionId",
              ExpressionAttributeValues: { ":sessionId": opts.sessionId },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

export async function putArchive(ctx: PlaneStorageCtx, obj: ArchiveObject): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.archives,
      Item: { ...obj },
    }),
  );
}

export async function getArchive(ctx: PlaneStorageCtx, key: string): Promise<ArchiveObject | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.archives, Key: { key } }));
  return (res.Item as ArchiveObject | undefined) ?? null;
}

export async function listArchives(ctx: PlaneStorageCtx): Promise<ArchiveObject[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.archives }));
  return (res.Items ?? []) as ArchiveObject[];
}

export async function putHostInventory(
  ctx: PlaneStorageCtx,
  rec: HostInventoryRecord,
): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.hostInventories,
      Item: { ...rec },
    }),
  );
}

export async function getHostInventory(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<HostInventoryRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.hostInventories, Key: { hostId } }),
  );
  return (res.Item as HostInventoryRecord | undefined) ?? null;
}

export async function listHostInventories(ctx: PlaneStorageCtx): Promise<HostInventoryRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.hostInventories }));
  return (res.Items ?? []) as HostInventoryRecord[];
}

export async function deleteHostInventory(ctx: PlaneStorageCtx, hostId: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.hostInventories, Key: { hostId } }));
}
