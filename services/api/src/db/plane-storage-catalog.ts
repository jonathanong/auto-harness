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
  isConditionalTransactionFailureAt,
  type HostInventoryRecord,
  type ArchiveObject,
  type LogQuery,
  type LogRecord,
  type PlaneStorageCtx,
  type RepositoryRecord,
  type ScheduleRecord,
} from "./plane-storage-types.ts";
import {
  guardedWrite,
  markerConditions,
  ownedDelete,
  withMarkerTable,
  type DeletionMarker,
  type OwnedDeletionMarker,
} from "./plane-storage-deletion-markers.ts";
import type { SessionRecord } from "./types.ts";
import { sessionToItem } from "./plane-storage-types.ts";
import {
  getConcurrencyLock,
  getSession,
  releaseConcurrencyLock,
} from "./plane-storage-sessions.ts";

/** Interpret conditional DynamoDB write failures without a client double. */
export function conditionalCatalogWriteOrThrow(err: unknown): false {
  if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
  throw err;
}

export function catalogItem<T>(item: T | undefined): T | null {
  return item ?? null;
}

export function catalogPageItems<T>(items: T[] | undefined): T[] {
  return items ?? [];
}

export function nextCatalogPage(
  key: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return key && Object.keys(key).length > 0 ? key : undefined;
}

export function scheduleAttributes(
  attributes: Record<string, unknown> | undefined,
): ScheduleRecord | null {
  return attributes ? (attributes as ScheduleRecord) : null;
}

export function isActiveSession(session: SessionRecord | null): session is SessionRecord {
  return session?.status === "queued" || session?.status === "running";
}

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
    return conditionalCatalogWriteOrThrow(err);
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
  const records: LogRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessionLogs,
        KeyConditionExpression: "sessionId = :s",
        ExpressionAttributeValues: { ":s": sessionId },
        ScanIndexForward: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as LogRecord[] | undefined));
    startKey = nextCatalogPage(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

/**
 * Bounded durable history query for the REST endpoint. A `since` key range
 * lets DynamoDB skip older history; stream is not indexed, so it is applied
 * as a Dynamo filter while pagination continues until enough matching rows
 * are collected. Full unbounded reads remain available only for hydration.
 */
export async function queryLogs(
  ctx: PlaneStorageCtx,
  sessionId: string,
  query: LogQuery,
): Promise<LogRecord[]> {
  if (query.after) {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessionLogs,
        KeyConditionExpression: "sessionId = :sessionId AND timestampSeq > :after",
        ExpressionAttributeValues: { ":sessionId": sessionId, ":after": query.after },
        ScanIndexForward: true,
        Limit: query.limit,
      }),
    );
    return catalogPageItems(res.Items as LogRecord[] | undefined);
  }
  const records: LogRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessionLogs,
        KeyConditionExpression: query.since
          ? "sessionId = :s AND timestampSeq > :since"
          : "sessionId = :s",
        ExpressionAttributeValues: {
          ":s": sessionId,
          ...(query.since ? { ":since": `${query.since}\uffff` } : {}),
          ...(query.stream ? { ":stream": query.stream } : {}),
        },
        ...(query.stream ? { FilterExpression: "stream = :stream" } : {}),
        ScanIndexForward: true,
        Limit: query.limit - records.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as LogRecord[] | undefined));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && records.length < query.limit);
  return records;
}

export async function putSchedule(
  ctx: PlaneStorageCtx,
  rec: ScheduleRecord,
  markers?: readonly DeletionMarker[],
): Promise<void> {
  const write = { Put: { TableName: ctx.tables.schedules, Item: { ...rec } } };
  await guardedWrite(ctx, markers, write, async () => {
    await ctx.doc.send(new PutCommand(write.Put));
  });
}

/**
 * Update operator-owned schedule fields and reset the cron cursor only while
 * the cursor still matches the caller's snapshot. Scheduler claims advance
 * nextRunAt conditionally, so this fence prevents a management write from
 * restoring a cursor read before a concurrent claim succeeded.
 */
export async function updateScheduleManagement(
  ctx: PlaneStorageCtx,
  rec: ScheduleRecord,
  expectedNextRunAt: string,
  markers?: readonly DeletionMarker[],
): Promise<ScheduleRecord | null> {
  try {
    const set = [
      "repositoryId = :repositoryId",
      "#name = :name",
      "target = :target",
      "fallbacks = :fallbacks",
      "targetLabels = :targetLabels",
      "cron = :cron",
      "enabled = :enabled",
      "timeout = :timeout",
      "queueTtlSeconds = :queueTtlSeconds",
      "nextRunAt = :nextRunAt",
      "createdAt = :createdAt",
    ];
    const remove: string[] = [];
    if (rec.ref === undefined) remove.push("#ref");
    else set.push("#ref = :ref");
    if (rec.concurrencyId === undefined) remove.push("concurrencyId");
    else set.push("concurrencyId = :concurrencyId");
    const update = {
      TableName: ctx.tables.schedules,
      Key: { id: rec.id },
      UpdateExpression: `SET ${set.join(", ")}${remove.length === 0 ? "" : ` REMOVE ${remove.join(", ")}`}`,
      ConditionExpression: "attribute_exists(id) AND nextRunAt = :expectedNextRunAt",
      ExpressionAttributeNames: { "#name": "name", "#ref": "ref" },
      ExpressionAttributeValues: {
        ":repositoryId": rec.repositoryId,
        ":name": rec.name,
        ":target": rec.target,
        ":fallbacks": rec.fallbacks,
        ":targetLabels": rec.targetLabels,
        ":cron": rec.cron,
        ":enabled": rec.enabled,
        ":timeout": rec.timeout,
        ":queueTtlSeconds": rec.queueTtlSeconds,
        ":nextRunAt": rec.nextRunAt,
        ":expectedNextRunAt": expectedNextRunAt,
        ":createdAt": rec.createdAt,
        ...(rec.ref === undefined ? {} : { ":ref": rec.ref }),
        ...(rec.concurrencyId === undefined ? {} : { ":concurrencyId": rec.concurrencyId }),
      },
    };
    if (markers?.length) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            ...withMarkerTable(ctx, markerConditions([...markers])),
            { Update: update },
          ],
        }),
      );
      return getSchedule(ctx, rec.id, true);
    }
    const res = await ctx.doc.send(new UpdateCommand({ ...update, ReturnValues: "ALL_NEW" }));
    return scheduleAttributes(res.Attributes as Record<string, unknown> | undefined);
  } catch (err) {
    conditionalCatalogWriteOrThrow(err);
    return null;
  }
}

export async function getSchedule(
  ctx: PlaneStorageCtx,
  id: string,
  consistentRead = false,
): Promise<ScheduleRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.schedules,
      Key: { id },
      ...(consistentRead ? { ConsistentRead: true } : {}),
    }),
  );
  return catalogItem(res.Item as ScheduleRecord | undefined);
}

export async function listSchedules(ctx: PlaneStorageCtx): Promise<ScheduleRecord[]> {
  const records: ScheduleRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ConsistentRead: true,
        TableName: ctx.tables.schedules,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as ScheduleRecord[] | undefined));
    startKey = nextCatalogPage(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
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

/** Insert a repository without allowing a stale process to overwrite it. */
export async function createRepository(
  ctx: PlaneStorageCtx,
  rec: RepositoryRecord,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.repositories,
        Item: { ...rec },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return true;
  } catch (err) {
    return conditionalCatalogWriteOrThrow(err);
  }
}

export async function getRepository(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<RepositoryRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.repositories, Key: { id } }),
  );
  return catalogItem(res.Item as RepositoryRecord | undefined);
}

export async function listRepositories(ctx: PlaneStorageCtx): Promise<RepositoryRecord[]> {
  const records: RepositoryRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ConsistentRead: true,
        TableName: ctx.tables.repositories,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as RepositoryRecord[] | undefined));
    startKey = nextCatalogPage(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function deleteRepository(
  ctx: PlaneStorageCtx,
  id: string,
  markers?: readonly OwnedDeletionMarker[],
): Promise<void> {
  const write = { Delete: { TableName: ctx.tables.repositories, Key: { id } } };
  if (markers?.length) return ownedDelete(ctx, markers, write);
  await ctx.doc.send(new DeleteCommand(write.Delete));
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
    return conditionalCatalogWriteOrThrow(err);
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
      // The schedule cursor is item 0, the session insert is item 1, and
      // the concurrency lock (when present) is item 2. Only a failed lock
      // condition means an active session can be a legitimate duplicate.
      if (opts.session.concurrencyId && isConditionalTransactionFailureAt(err, 2)) {
        const lock = await getConcurrencyLock(ctx, opts.session.concurrencyId);
        if (lock) {
          const current = await getSession(ctx, lock.sessionId, true);
          if (isActiveSession(current)) {
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
    return conditionalCatalogWriteOrThrow(err);
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
  return catalogItem(res.Item as ArchiveObject | undefined);
}

export async function listArchives(ctx: PlaneStorageCtx): Promise<ArchiveObject[]> {
  const records: ArchiveObject[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ConsistentRead: true,
        TableName: ctx.tables.archives,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as ArchiveObject[] | undefined));
    startKey = nextCatalogPage(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function putHostInventory(
  ctx: PlaneStorageCtx,
  rec: HostInventoryRecord,
  markers?: readonly DeletionMarker[],
): Promise<void> {
  const write = { Put: { TableName: ctx.tables.hostInventories, Item: { ...rec } } };
  await guardedWrite(ctx, markers, write, async () => {
    await ctx.doc.send(new PutCommand(write.Put));
  });
}

export async function getHostInventory(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<HostInventoryRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.hostInventories, Key: { hostId } }),
  );
  return catalogItem(res.Item as HostInventoryRecord | undefined);
}

export async function listHostInventories(ctx: PlaneStorageCtx): Promise<HostInventoryRecord[]> {
  const records: HostInventoryRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ConsistentRead: true,
        TableName: ctx.tables.hostInventories,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as HostInventoryRecord[] | undefined));
    startKey = nextCatalogPage(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function deleteHostInventory(ctx: PlaneStorageCtx, hostId: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.hostInventories, Key: { hostId } }));
}
