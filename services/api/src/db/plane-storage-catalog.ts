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
  type ArchiveMetadata,
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
import type { RepositoryAdmissionState } from "@auto-harness/shared";
import { sessionToItem } from "./plane-storage-types.ts";
import {
  getConcurrencyLock,
  getSession,
  releaseConcurrencyLock,
} from "./plane-storage-sessions.ts";
import { nextPageKey } from "./plane-storage-types.ts";

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

/**
 * Persist one bounded ingress batch behind the same connection fence as a
 * single log. A transaction is intentional: BatchWriteItem cannot condition
 * the write on the host lease and could therefore admit stale-socket logs.
 */
export async function putLogsFenced(
  ctx: PlaneStorageCtx,
  records: readonly LogRecord[],
  fence: { hostId: string; connectionId: string },
): Promise<boolean> {
  if (records.length === 0) return true;
  const uniqueRecords = new Map<string, LogRecord>();
  for (const record of records) {
    uniqueRecords.set(JSON.stringify([record.sessionId, record.timestampSeq]), record);
  }
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
          ...[...uniqueRecords.values()].map((record) => ({
            Put: { TableName: ctx.tables.sessionLogs, Item: { ...record } },
          })),
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
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
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
        ExpressionAttributeValues: {
          ":sessionId": sessionId,
          ":after": query.after,
          ...(query.stream ? { ":stream": query.stream } : {}),
        },
        ...(query.stream
          ? {
              FilterExpression: "#stream = :stream",
              ExpressionAttributeNames: { "#stream": "stream" },
            }
          : {}),
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
        ...(query.stream
          ? {
              FilterExpression: "#stream = :stream",
              ExpressionAttributeNames: { "#stream": "stream" },
            }
          : {}),
        ScanIndexForward: true,
        Limit: query.limit - records.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as LogRecord[] | undefined));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
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
    if (rec.prompt === undefined) remove.push("prompt");
    else set.push("prompt = :prompt");
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
        ...(rec.prompt === undefined ? {} : { ":prompt": rec.prompt }),
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
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
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

/** Update operator-editable settings without overwriting admission/drain fields. */
export async function updateRepositorySettings(
  ctx: PlaneStorageCtx,
  id: string,
  patch: Partial<
    Pick<RepositoryRecord, "name" | "url" | "defaultBranch" | "setupScript" | "terminalHookScript">
  >,
  updatedAt: string,
): Promise<RepositoryRecord | null> {
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":updatedAt": updatedAt };
  const sets = ["#updatedAt = :updatedAt"];
  for (const key of [
    "name",
    "url",
    "defaultBranch",
    "setupScript",
    "terminalHookScript",
  ] as const) {
    if (patch[key] === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = patch[key];
    sets.push(`#${key} = :${key}`);
  }
  try {
    const result = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.repositories,
        Key: { id },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return catalogItem(result.Attributes as RepositoryRecord | undefined);
  } catch (error) {
    if (isConditionalFailed(error)) return null;
    throw error;
  }
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
    new GetCommand({ TableName: ctx.tables.repositories, Key: { id }, ConsistentRead: true }),
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
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function setRepositoryAdmissionState(
  ctx: PlaneStorageCtx,
  id: string,
  state: RepositoryAdmissionState,
  now: string,
): Promise<RepositoryRecord | null> {
  const names = { "#state": "admissionState" };
  const activating = state === "active";
  const resumingAdmission = state !== "draining";
  const draining = state === "draining";
  try {
    const res = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.repositories,
        Key: { id },
        UpdateExpression: [
          "SET #state = :state, admissionStateChangedAt = :now, updatedAt = :now",
          ...(draining ? [", drainRequestedAt = :now REMOVE drainCompletedAt"] : []),
          ...(activating ? [" REMOVE drainRequestedAt, drainCompletedAt"] : []),
        ].join(""),
        ConditionExpression: resumingAdmission
          ? "attribute_exists(id) AND (attribute_not_exists(#state) OR #state <> :draining)"
          : "attribute_exists(id)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ":state": state,
          ":now": now,
          ...(resumingAdmission ? { ":draining": "draining" } : {}),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return catalogItem(res.Attributes as RepositoryRecord | undefined);
  } catch (err) {
    if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return null;
    throw err;
  }
}

/** Finish a drain only if this repository is still behind the same drain fence. */
export async function completeRepositoryDrain(
  ctx: PlaneStorageCtx,
  id: string,
  drainRequestedAt: string,
  now: string,
): Promise<RepositoryRecord | null> {
  try {
    const res = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.repositories,
        Key: { id },
        UpdateExpression:
          "SET admissionState = :paused, admissionStateChangedAt = :now, drainCompletedAt = :now, updatedAt = :now",
        ConditionExpression: "admissionState = :draining AND drainRequestedAt = :drainRequestedAt",
        ExpressionAttributeValues: {
          ":paused": "paused",
          ":draining": "draining",
          ":drainRequestedAt": drainRequestedAt,
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return catalogItem(res.Attributes as RepositoryRecord | undefined);
  } catch (err) {
    if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return null;
    throw err;
  }
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
  | { kind: "admission_closed" }
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
            ConditionCheck: {
              TableName: ctx.tables.repositories,
              Key: { id: opts.session.repositoryId },
              ConditionExpression:
                "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)",
              ExpressionAttributeValues: { ":active": "active" },
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
      if (isConditionalTransactionFailureAt(err, 1)) {
        return { kind: "admission_closed" };
      }
      // The schedule cursor is item 0, repository fence item 1, the session
      // insert item 2, and the concurrency lock (when present) item 3. Only a failed lock
      // condition means an active session can be a legitimate duplicate.
      if (opts.session.concurrencyId && isConditionalTransactionFailureAt(err, 3)) {
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

/** Advance a due cron cursor only while repository admission remains closed. */
export async function skipScheduleForClosedRepository(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    repositoryId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
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
              TableName: ctx.tables.repositories,
              Key: { id: opts.repositoryId },
              ConditionExpression: "admissionState = :paused OR admissionState = :draining",
              ExpressionAttributeValues: { ":paused": "paused", ":draining": "draining" },
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

export async function putArchive(ctx: PlaneStorageCtx, obj: ArchiveMetadata): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.archives,
      Item: { ...obj },
    }),
  );
}

export async function getArchive(
  ctx: PlaneStorageCtx,
  key: string,
): Promise<ArchiveMetadata | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.archives, Key: { key } }));
  return catalogItem(res.Item as ArchiveMetadata | undefined);
}

export async function listArchives(ctx: PlaneStorageCtx): Promise<ArchiveMetadata[]> {
  const records: ArchiveMetadata[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ConsistentRead: true,
        TableName: ctx.tables.archives,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...catalogPageItems(res.Items as ArchiveMetadata[] | undefined));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

/**
 * Build the `ConditionExpression`/`ExpressionAttributeValues` pair that makes an inventory
 * write conditional on the version the caller read, shared by `putHostInventory` and
 * `putHostInventoryFenced` so the two condition strings cannot drift apart. Version 0
 * means "the caller read a document with no version yet", which is either a
 * pre-versioning row or no row at all.
 */
function inventoryVersionCondition(expectedVersion: number | undefined): {
  ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  if (expectedVersion === undefined) return {};
  if (expectedVersion === 0) {
    return {
      ConditionExpression: "attribute_not_exists(version) OR version = :expected",
      ExpressionAttributeValues: { ":expected": 0 },
    };
  }
  return {
    ConditionExpression: "version = :expected",
    ExpressionAttributeValues: { ":expected": expectedVersion },
  };
}

/**
 * Replace a host's inventory document.
 *
 * `expectedVersion` makes the replace conditional on the document not having moved since
 * the caller read it. Without it this was an unconditional whole-document Put, so the
 * control plane adding a worktree while the host pane added another silently dropped one
 * of them — and the worktree projection then deleted the orphaned Worktrees rows.
 * Returns false when the condition fails so the caller can answer 409.
 */
export async function putHostInventory(
  ctx: PlaneStorageCtx,
  rec: HostInventoryRecord,
  markers?: readonly DeletionMarker[],
  expectedVersion?: number,
): Promise<boolean> {
  const write = {
    Put: {
      TableName: ctx.tables.hostInventories,
      Item: { ...rec },
      ...inventoryVersionCondition(expectedVersion),
    },
  };
  try {
    await guardedWrite(ctx, markers, write, async () => {
      await ctx.doc.send(new PutCommand(write.Put));
    });
    return true;
  } catch (err) {
    return conditionalCatalogWriteOrThrow(err);
  }
}

/**
 * Publish inventory only while the registering connection still owns the host lease.
 *
 * `expectedVersion`, when given, additionally conditions the inventory half of the
 * transaction on the version the caller read. Without it, a registration that read the
 * inventory before a concurrent UI edit committed a newer version would overwrite that
 * edit — the transaction only fenced on the connection lease, which a UI edit never
 * touches, so nothing here ever detected the collision. The two condition failures are
 * distinguished by which transaction item DynamoDB reports failed (index 0: the lease
 * moved to another connection, not retryable here; index 1: the version moved, retryable
 * by the caller re-reading and rebuilding against the current document).
 */
export async function putHostInventoryFenced(
  ctx: PlaneStorageCtx,
  rec: HostInventoryRecord,
  fence: { hostId: string; connectionId: string },
  expectedVersion?: number,
): Promise<{ ok: true } | { ok: false; reason: "lease" | "version" }> {
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
          {
            Put: {
              TableName: ctx.tables.hostInventories,
              Item: { ...rec },
              ...inventoryVersionCondition(expectedVersion),
            },
          },
        ],
      }),
    );
    return { ok: true };
  } catch (err) {
    if (!isConditionalTransactionFailed(err)) throw err;
    return { ok: false, reason: isConditionalTransactionFailureAt(err, 1) ? "version" : "lease" };
  }
}

export async function getHostInventory(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<HostInventoryRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.hostInventories,
      Key: { hostId },
      ConsistentRead: true,
    }),
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
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function deleteHostInventory(ctx: PlaneStorageCtx, hostId: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.hostInventories, Key: { hostId } }));
}
