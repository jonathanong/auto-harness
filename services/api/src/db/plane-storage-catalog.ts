/* eslint-disable max-lines */
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { sessionLogsTtlEpochSeconds } from "./dynamo.ts";
import { ARCHIVE_RETRY_INDEX } from "./ensure-archive-retry-index.ts";
import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  isConditionalTransactionFailureAt,
  normalizeTargetDisplayNames,
  type HostInventoryRecord,
  type ArchiveMetadata,
  type HostLogFence,
  type LogQuery,
  type LogRecord,
  type PlaneStorageCtx,
  type RepositoryRecord,
  type RepositoryPage,
  type RepositoryPageQuery,
  type ScheduleRecord,
} from "./plane-storage-types.ts";
import {
  guardedWrite,
  markerConditions,
  ownedDelete,
  principalExistsCheck,
  withMarkerTable,
  type DeletionMarker,
  type OwnedDeletionMarker,
} from "./plane-storage-deletion-markers.ts";
import type { SessionRecord } from "./types.ts";
import { MAX_FALLBACKS, type RepositoryAdmissionState } from "@auto-harness/shared";
import { sessionToItem } from "./plane-storage-types.ts";
import {
  getConcurrencyLock,
  getSession,
  releaseConcurrencyLock,
} from "./plane-storage-sessions.ts";
import { nextPageKey } from "./plane-storage-types.ts";
import {
  getSessionDrain,
  sessionDrainActivityPut,
  sessionDrainAdmissionCheck,
  sessionDrainScopeKey,
} from "./plane-storage-session-drains.ts";
import { auditLogItem } from "./plane-storage-audit.ts";
import type { AuditLogRecord } from "../audit-types.ts";

function sessionLogItem(rec: LogRecord): LogRecord & { ttl: number } {
  return { ...rec, ttl: sessionLogsTtlEpochSeconds() };
}

function hostLockCheck(ctx: PlaneStorageCtx, fence: HostLogFence) {
  return {
    ConditionCheck: {
      TableName: ctx.tables.hostLocks,
      Key: { hostId: fence.hostId },
      ConditionExpression: "connectionId = :connectionId",
      ExpressionAttributeValues: { ":connectionId": fence.connectionId },
    },
  };
}

function sessionAttemptChecks(ctx: PlaneStorageCtx, fence: HostLogFence) {
  const unique = new Map<string, string>();
  for (const attempt of fence.attempts ?? []) {
    const existing = unique.get(attempt.sessionId);
    if (existing !== undefined && existing !== attempt.attemptId) return null;
    unique.set(attempt.sessionId, attempt.attemptId);
  }
  return [...unique.entries()].map(([sessionId, attemptId]) => ({
    ConditionCheck: {
      TableName: ctx.tables.sessions,
      Key: { id: sessionId },
      ConditionExpression: "attemptId = :attemptId",
      ExpressionAttributeValues: { ":attemptId": attemptId },
    },
  }));
}

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
  return attributes ? (normalizeTargetDisplayNames(attributes) as ScheduleRecord) : null;
}

export function isActiveSession(session: SessionRecord | null): session is SessionRecord {
  return session?.status === "queued" || session?.status === "running";
}

export async function putLog(ctx: PlaneStorageCtx, rec: LogRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessionLogs,
      Item: sessionLogItem(rec),
    }),
  );
}

export async function putLogFenced(
  ctx: PlaneStorageCtx,
  rec: LogRecord,
  fence: HostLogFence,
): Promise<boolean> {
  const attempts = sessionAttemptChecks(ctx, fence);
  if (attempts === null) return false;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          hostLockCheck(ctx, fence),
          ...attempts,
          { Put: { TableName: ctx.tables.sessionLogs, Item: sessionLogItem(rec) } },
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
  fence: HostLogFence,
): Promise<boolean> {
  if (records.length === 0) return true;
  const attempts = sessionAttemptChecks(ctx, fence);
  if (attempts === null) return false;
  const uniqueRecords = new Map<string, LogRecord>();
  for (const record of records) {
    uniqueRecords.set(JSON.stringify([record.sessionId, record.timestampSeq]), record);
  }
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          hostLockCheck(ctx, fence),
          ...attempts,
          ...[...uniqueRecords.values()].map((record) => ({
            Put: { TableName: ctx.tables.sessionLogs, Item: sessionLogItem(record) },
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

/**
 * `consistentRead` defaults to false (eventually consistent, half the RCU cost) for the
 * common high-volume readers — REST/viewer tail display and archive writes, both of which
 * self-correct on the next read. A caller that bakes this result into something immutable
 * (the Slack outbox's one-ID-per-lifecycle-action rows) must pass `true`: an eventually
 * consistent read racing the host's own final `session:log` write could legally return a
 * transcript missing that last chunk, and unlike the other callers there is no later read
 * that would ever surface the miss.
 */
export async function listLogs(
  ctx: PlaneStorageCtx,
  sessionId: string,
  consistentRead = false,
): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessionLogs,
        KeyConditionExpression: "sessionId = :s",
        ExpressionAttributeValues: { ":s": sessionId },
        ScanIndexForward: true,
        ...(consistentRead ? { ConsistentRead: true } : {}),
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
  const principalCheck = principalExistsCheck(ctx, rec.principalId);
  await guardedWrite(
    ctx,
    markers,
    write,
    async () => {
      await ctx.doc.send(new PutCommand(write.Put));
    },
    principalCheck ? [principalCheck] : [],
  );
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
      "targetDisplayNames = :targetDisplayNames",
      "cron = :cron",
      "enabled = :enabled",
      "timeout = :timeout",
      "queueTtlSeconds = :queueTtlSeconds",
      "nextRunAt = :nextRunAt",
      "createdAt = :createdAt",
    ];
    const remove = ["targetLabels"];
    if (rec.ref === undefined) remove.push("#ref");
    else set.push("#ref = :ref");
    if (rec.concurrencyId === undefined) remove.push("concurrencyId");
    else set.push("concurrencyId = :concurrencyId");
    if (rec.principalId === undefined) remove.push("principalId");
    else set.push("principalId = :principalId");
    if (rec.prompt === undefined) remove.push("prompt");
    else set.push("prompt = :prompt");
    const update = {
      TableName: ctx.tables.schedules,
      Key: { id: rec.id },
      UpdateExpression: `SET ${set.join(", ")} REMOVE ${remove.join(", ")}`,
      ConditionExpression:
        "attribute_exists(id) AND nextRunAt = :expectedNextRunAt AND " +
        (rec.principalId === undefined
          ? "attribute_not_exists(principalId)"
          : "(attribute_not_exists(principalId) OR principalId = :principalId)"),
      ExpressionAttributeNames: { "#name": "name", "#ref": "ref" },
      ExpressionAttributeValues: {
        ":repositoryId": rec.repositoryId,
        ":name": rec.name,
        ":target": rec.target,
        ":fallbacks": rec.fallbacks,
        ":targetDisplayNames": rec.targetDisplayNames,
        ":cron": rec.cron,
        ":enabled": rec.enabled,
        ":timeout": rec.timeout,
        ":queueTtlSeconds": rec.queueTtlSeconds,
        ":nextRunAt": rec.nextRunAt,
        ":expectedNextRunAt": expectedNextRunAt,
        ":createdAt": rec.createdAt,
        ...(rec.ref === undefined ? {} : { ":ref": rec.ref }),
        ...(rec.concurrencyId === undefined ? {} : { ":concurrencyId": rec.concurrencyId }),
        ...(rec.principalId === undefined ? {} : { ":principalId": rec.principalId }),
        ...(rec.prompt === undefined ? {} : { ":prompt": rec.prompt }),
      },
    };
    const principalCheck = principalExistsCheck(ctx, rec.principalId);
    const markerChecks = markers ? withMarkerTable(ctx, markerConditions([...markers])) : [];
    if (markerChecks.length + (principalCheck ? 1 : 0) > 99) {
      throw new Error("catalog reference write exceeds DynamoDB's 100 transaction action limit");
    }
    if (markerChecks.length || principalCheck) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            ...markerChecks,
            ...(principalCheck ? [principalCheck] : []),
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
  return scheduleAttributes(res.Item as Record<string, unknown> | undefined);
}

export async function listSchedules(
  ctx: PlaneStorageCtx,
  consistentRead = true,
): Promise<ScheduleRecord[]> {
  const records: ScheduleRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.schedules,
        ...(consistentRead ? { ConsistentRead: true } : {}),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(
      ...catalogPageItems(res.Items as Record<string, unknown>[] | undefined).map(
        (item) => normalizeTargetDisplayNames(item) as ScheduleRecord,
      ),
    );
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function deleteSchedule(
  ctx: PlaneStorageCtx,
  id: string,
  markers?: readonly OwnedDeletionMarker[],
): Promise<void> {
  const write = { Delete: { TableName: ctx.tables.schedules, Key: { id } } };
  if (markers?.length) return ownedDelete(ctx, markers, write);
  await ctx.doc.send(new DeleteCommand(write.Delete));
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

function scopeOffset(startKey: Record<string, unknown> | undefined): number {
  const value = startKey?.scopeOffset;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const BATCH_GET_MAX_ATTEMPTS = 5;
const BATCH_GET_BASE_RETRY_DELAY_MS = 50;

async function listAllowedRepositoriesPage(
  ctx: PlaneStorageCtx,
  query: RepositoryPageQuery,
  repositoryIds: readonly string[],
): Promise<RepositoryPage> {
  if (repositoryIds.length === 0) return { items: [], nextKey: null };
  const offset = scopeOffset(query.startKey);
  const ids = repositoryIds.slice(offset, offset + query.limit);
  if (ids.length === 0) return { items: [], nextKey: null };
  const byId = new Map<string, RepositoryRecord>();
  let pending = ids.map((id) => ({ id }));
  for (let attempt = 0; pending.length && attempt < BATCH_GET_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const backoff = BATCH_GET_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      // Cryptographic randomness is used only to desynchronize retries, never as an identifier.
      await delay(backoff + randomInt(backoff)); // NOSONAR
    }
    const response = await ctx.doc.send(
      new BatchGetCommand({
        RequestItems: {
          [ctx.tables.repositories]: {
            Keys: pending,
            ConsistentRead: true,
          },
        },
      }),
    );
    for (const record of catalogPageItems(
      response.Responses?.[ctx.tables.repositories] as RepositoryRecord[] | undefined,
    )) {
      byId.set(record.id, record);
    }
    pending =
      (response.UnprocessedKeys?.[ctx.tables.repositories]?.Keys as typeof pending | undefined) ??
      [];
  }
  if (pending.length > 0) {
    throw new Error("repository page read was throttled");
  }
  const nextOffset = offset + ids.length;
  return {
    items: ids.flatMap((id) => {
      const record = byId.get(id);
      return record ? [record] : [];
    }),
    nextKey: nextOffset < repositoryIds.length ? { scopeOffset: nextOffset } : null,
  };
}

/** Read one strongly consistent, bounded page from the repository table. */
export async function listRepositoriesPage(
  ctx: PlaneStorageCtx,
  query: RepositoryPageQuery,
): Promise<RepositoryPage> {
  if (query.allowedRepositoryIds !== undefined) {
    return listAllowedRepositoriesPage(ctx, query, query.allowedRepositoryIds);
  }
  const result = await ctx.doc.send(
    new ScanCommand({
      TableName: ctx.tables.repositories,
      ConsistentRead: true,
      Limit: query.limit + 1,
      ...(query.startKey ? { ExclusiveStartKey: query.startKey } : {}),
    }),
  );
  const items = catalogPageItems(result.Items as RepositoryRecord[] | undefined);
  const pageItems = items.slice(0, query.limit);
  const lookahead = pageItems.at(-1);
  return {
    items: pageItems,
    nextKey:
      items.length > query.limit && lookahead
        ? { id: lookahead.id }
        : (nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined) ?? null),
  };
}

export async function setRepositoryAdmissionState(
  ctx: PlaneStorageCtx,
  id: string,
  state: RepositoryAdmissionState,
  now: string,
  activationCutoffAt?: string,
): Promise<RepositoryRecord | null> {
  const names = { "#state": "admissionState" };
  const activating = activationCutoffAt !== undefined;
  const resumingAdmission = state !== "draining";
  const draining = state === "draining";
  let conditionExpression = "attribute_exists(id)";
  if (activating) {
    conditionExpression += " AND #state = :paused";
  } else if (state === "active") {
    // A caller that observed an already-active (including legacy) row must
    // not reopen a repository that was paused between its read and this
    // write. A reopening write supplies a fresh activation cutoff instead.
    conditionExpression += " AND (attribute_not_exists(#state) OR #state = :active)";
  } else if (resumingAdmission) {
    conditionExpression += " AND (attribute_not_exists(#state) OR #state <> :draining)";
  }
  try {
    const res = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.repositories,
        Key: { id },
        UpdateExpression: [
          "SET #state = :state, admissionStateChangedAt = :now, updatedAt = :now",
          ...(draining ? [", drainRequestedAt = :now REMOVE drainCompletedAt"] : []),
          ...(activating
            ? [
                ", activationCutoffAt = :activationCutoffAt REMOVE drainRequestedAt, drainCompletedAt",
              ]
            : []),
        ].join(""),
        ConditionExpression: conditionExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ":state": state,
          ":now": now,
          ...(activating ? { ":activationCutoffAt": activationCutoffAt } : {}),
          ...(activating ? { ":paused": "paused" } : {}),
          ...(state === "active" && !activating ? { ":active": "active" } : {}),
          ...(resumingAdmission && !activating && state !== "active"
            ? { ":draining": "draining" }
            : {}),
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
 * Consume an ownerless legacy occurrence only while it remains ownerless, and
 * durably record why it was skipped in the same transaction.  The ownership
 * condition is essential: a concurrent authenticated claim must leave the
 * due occurrence available to run under that new owner.
 */
export async function skipOwnerlessScheduleAndAudit(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    lastRunAt: string;
    audit: AuditLogRecord;
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
              UpdateExpression: "SET nextRunAt = :nextRunAt, lastRunAt = :lastRunAt",
              ConditionExpression:
                "nextRunAt = :expectedNextRunAt AND enabled = :true AND attribute_not_exists(principalId)",
              ExpressionAttributeValues: {
                ":nextRunAt": opts.newNextRunAt,
                ":lastRunAt": opts.lastRunAt,
                ":expectedNextRunAt": opts.expectedNextRunAt,
                ":true": true,
              },
            },
          },
          {
            Put: {
              TableName: ctx.tables.auditLogs,
              Item: auditLogItem(opts.audit),
              ConditionExpression:
                "attribute_not_exists(#scope) AND attribute_not_exists(timestampId)",
              ExpressionAttributeNames: { "#scope": "scope" },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    return conditionalCatalogWriteOrThrow(error);
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
  | { kind: "draining"; operationId: string }
  /** A legacy persisted schedule exceeds the current transaction-safe route limit. */
  | { kind: "legacy_fallbacks"; fallbackCount: number }
  | { kind: "lost" };

/**
 * Disable a legacy schedule that cannot be admitted without exceeding DynamoDB's
 * 100-action transaction limit.  This is an explicit, audited migration boundary:
 * older rows accepted 91/92 fallbacks, while current writes are capped at 90.
 * Keeping this separate from the session transaction avoids both a hot retry loop
 * and a partially admitted scheduled session.
 */
export async function disableLegacyFallbackScheduleAndAudit(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    audit: AuditLogRecord;
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
              UpdateExpression: "SET enabled = :false",
              ConditionExpression:
                "nextRunAt = :expectedNextRunAt AND enabled = :true AND size(fallbacks) > :maxFallbacks",
              ExpressionAttributeValues: {
                ":false": false,
                ":true": true,
                ":expectedNextRunAt": opts.expectedNextRunAt,
                ":maxFallbacks": MAX_FALLBACKS,
              },
            },
          },
          {
            Put: {
              TableName: ctx.tables.auditLogs,
              Item: auditLogItem(opts.audit),
              ConditionExpression:
                "attribute_not_exists(#scope) AND attribute_not_exists(timestampId)",
              ExpressionAttributeNames: { "#scope": "scope" },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    return conditionalCatalogWriteOrThrow(error);
  }
}

export async function tryClaimScheduleAndCreateSession(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    lastRunAt: string;
    activationCutoffAt?: string;
    expectedNextRunAtEpochMs?: number;
    session: SessionRecord;
  },
): Promise<ScheduleCreateResult> {
  // Schedules persisted before MAX_FALLBACKS was lowered can still contain 91 or
  // 92 routes. Do not construct an over-limit transaction and let cron retry the
  // unchanged cursor forever; the caller performs an explicit audited disable.
  const fallbackCount = opts.session.fallbacks?.length ?? 0;
  if (fallbackCount > MAX_FALLBACKS) {
    return { kind: "legacy_fallbacks", fallbackCount };
  }
  const principalId =
    opts.session.principalId ??
    (typeof opts.session.metadata?.createdBy === "string"
      ? opts.session.metadata.createdBy
      : undefined);
  const drainCheck = sessionDrainAdmissionCheck(ctx, opts.session.repositoryId, principalId);
  const principalCheck = principalExistsCheck(ctx, principalId);
  const activityPut = sessionDrainActivityPut(ctx, opts.session);
  const markerChecks = withMarkerTable(
    ctx,
    markerConditions(scheduleClaimMarkers(opts.lastRunAt, opts.session)),
  );
  const drainIndex = 1;
  const principalIndex = drainIndex + Number(!!drainCheck);
  const repositoryIndex = principalIndex + Number(!!principalCheck);
  const markerStartIndex = repositoryIndex + 1;
  const sessionIndex = markerStartIndex + markerChecks.length;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.schedules,
              Key: { id: opts.scheduleId },
              UpdateExpression: "SET nextRunAt = :n, lastRunAt = :l",
              ConditionExpression: [
                "nextRunAt = :e AND enabled = :true",
                ...(opts.expectedNextRunAtEpochMs !== undefined && opts.activationCutoffAt
                  ? ["AND :expectedNextRunAtEpochMs >= :activationCutoffEpochMs"]
                  : []),
              ].join(" "),
              ExpressionAttributeValues: {
                ":n": opts.newNextRunAt,
                ":l": opts.lastRunAt,
                ":e": opts.expectedNextRunAt,
                ":true": true,
                ...(opts.expectedNextRunAtEpochMs !== undefined && opts.activationCutoffAt
                  ? {
                      ":expectedNextRunAtEpochMs": opts.expectedNextRunAtEpochMs,
                      ":activationCutoffEpochMs": Date.parse(opts.activationCutoffAt),
                    }
                  : {}),
              },
            },
          },
          ...(drainCheck ? [drainCheck] : []),
          ...(principalCheck ? [principalCheck] : []),
          {
            ConditionCheck: {
              TableName: ctx.tables.repositories,
              Key: { id: opts.session.repositoryId },
              ConditionExpression:
                "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)" +
                (opts.activationCutoffAt
                  ? " AND activationCutoffAt = :activationCutoffAt"
                  : " AND attribute_not_exists(activationCutoffAt)"),
              ExpressionAttributeValues: {
                ":active": "active",
                ...(opts.activationCutoffAt
                  ? { ":activationCutoffAt": opts.activationCutoffAt }
                  : {}),
              },
            },
          },
          ...markerChecks,
          {
            Put: {
              TableName: ctx.tables.sessions,
              Item: sessionToItem(opts.session),
              ConditionExpression: "attribute_not_exists(id)",
            },
          },
          ...(activityPut ? [activityPut] : []),
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
      if (
        markerChecks.some((_, index) =>
          isConditionalTransactionFailureAt(err, markerStartIndex + index),
        )
      ) {
        // Deletion markers are part of this transaction, so a lost marker
        // cannot have advanced the schedule cursor or created a session.
        return { kind: "lost" };
      }
      if (drainCheck && isConditionalTransactionFailureAt(err, drainIndex)) {
        const drain = await getSessionDrain(ctx, opts.session.repositoryId, principalId!);
        return { kind: "draining", operationId: drain?.operationId ?? "unknown" };
      }
      if (principalCheck && isConditionalTransactionFailureAt(err, principalIndex)) {
        return { kind: "lost" };
      }
      if (isConditionalTransactionFailureAt(err, repositoryIndex)) {
        return { kind: "admission_closed" };
      }
      // The schedule cursor is followed by the optional principal drain
      // fence, repository fence, deletion markers, session insert, optional
      // activity member, and optional lock.
      const lockIndex = sessionIndex + 1 + Number(!!activityPut);
      if (opts.session.concurrencyId && isConditionalTransactionFailureAt(err, lockIndex)) {
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

function scheduleClaimMarkers(
  now: string,
  session: Pick<
    SessionRecord,
    "repositoryId" | "principalId" | "metadata" | "target" | "fallbacks"
  >,
): DeletionMarker[] {
  const keys = new Set<string>([`repository:${session.repositoryId}`]);
  const principalId =
    session.principalId ??
    (typeof session.metadata?.createdBy === "string" ? session.metadata.createdBy : undefined);
  if (principalId && principalId !== "system") keys.add(`principal:${principalId}`);
  for (const route of [session.target, ...(session.fallbacks ?? [])]) {
    if (!route) continue;
    keys.add("providerId" in route ? `provider:${route.providerId}` : `command:${route.commandId}`);
  }
  return [...keys]
    .toSorted((left, right) => left.localeCompare(right))
    .map((key) => ({ key, now }));
}

export async function skipScheduleForPrincipalDrain(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    repositoryId: string;
    principalId: string;
    operationId: string;
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
              ConditionExpression:
                "nextRunAt = :expectedNextRunAt AND enabled = :true AND repositoryId = :repositoryId AND principalId = :principalId",
              ExpressionAttributeValues: {
                ":nextRunAt": opts.newNextRunAt,
                ":expectedNextRunAt": opts.expectedNextRunAt,
                ":true": true,
                ":repositoryId": opts.repositoryId,
                ":principalId": opts.principalId,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: ctx.tables.sessionDrains,
              Key: {
                scopeKey: sessionDrainScopeKey(opts.repositoryId, opts.principalId),
                recordKey: "CURRENT",
              },
              ConditionExpression: "operationId = :operationId AND #status <> :released",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":operationId": opts.operationId,
                ":released": "released",
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    return conditionalCatalogWriteOrThrow(error);
  }
}

/** Advance a draining principal's cursor and append the rejection audit atomically. */
export async function skipScheduleForPrincipalDrainAndAudit(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    repositoryId: string;
    principalId: string;
    operationId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    audit: AuditLogRecord;
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
              ConditionExpression:
                "nextRunAt = :expectedNextRunAt AND enabled = :true AND repositoryId = :repositoryId AND principalId = :principalId",
              ExpressionAttributeValues: {
                ":nextRunAt": opts.newNextRunAt,
                ":expectedNextRunAt": opts.expectedNextRunAt,
                ":true": true,
                ":repositoryId": opts.repositoryId,
                ":principalId": opts.principalId,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: ctx.tables.sessionDrains,
              Key: {
                scopeKey: sessionDrainScopeKey(opts.repositoryId, opts.principalId),
                recordKey: "CURRENT",
              },
              ConditionExpression: "operationId = :operationId AND #status <> :released",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":operationId": opts.operationId,
                ":released": "released",
              },
            },
          },
          {
            Put: {
              TableName: ctx.tables.auditLogs,
              Item: auditLogItem(opts.audit),
              ConditionExpression:
                "attribute_not_exists(#scope) AND attribute_not_exists(timestampId)",
              ExpressionAttributeNames: { "#scope": "scope" },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    return conditionalCatalogWriteOrThrow(error);
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

/**
 * Atomically acknowledge a closed-admission occurrence by advancing its cursor.
 *
 * A failed create transaction is only an advisory observation: activation may
 * run before this follow-up starts. The repository condition here is therefore
 * part of the authoritative observation. A successful result proves that the
 * same DynamoDB transaction saw both the old cursor and paused/draining
 * admission, so activation cannot reopen this occurrence as catch-up work.
 */
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
              ConditionExpression:
                "nextRunAt = :expectedNextRunAt AND enabled = :true AND repositoryId = :repositoryId",
              ExpressionAttributeValues: {
                ":nextRunAt": opts.newNextRunAt,
                ":expectedNextRunAt": opts.expectedNextRunAt,
                ":true": true,
                ":repositoryId": opts.repositoryId,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: ctx.tables.repositories,
              Key: { id: opts.repositoryId },
              // A missing legacy admissionState means active. Do not allow this
              // closed-only cursor advance after the repository has reopened.
              ConditionExpression: "admissionState IN (:paused, :draining)",
              ExpressionAttributeValues: {
                ":paused": "paused",
                ":draining": "draining",
              },
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

/**
 * Advance an occurrence that predates a repository's latest activation
 * cutover. Both the schedule cursor and the active repository generation are
 * fenced in one transaction so an old scheduler read cannot consume work from
 * a subsequent close/reopen cycle.
 */
export async function skipScheduleBeforeActivationCutoff(
  ctx: PlaneStorageCtx,
  opts: {
    scheduleId: string;
    repositoryId: string;
    activationCutoffAt: string;
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
              ConditionExpression:
                "nextRunAt = :expectedNextRunAt AND :expectedNextRunAtEpochMs < :activationCutoffEpochMs AND enabled = :true AND repositoryId = :repositoryId",
              ExpressionAttributeValues: {
                ":nextRunAt": opts.newNextRunAt,
                ":expectedNextRunAt": opts.expectedNextRunAt,
                ":expectedNextRunAtEpochMs": Date.parse(opts.expectedNextRunAt),
                ":activationCutoffEpochMs": Date.parse(opts.activationCutoffAt),
                ":true": true,
                ":repositoryId": opts.repositoryId,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: ctx.tables.repositories,
              Key: { id: opts.repositoryId },
              ConditionExpression:
                "admissionState = :active AND activationCutoffAt = :activationCutoffAt",
              ExpressionAttributeValues: {
                ":active": "active",
                ":activationCutoffAt": opts.activationCutoffAt,
              },
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

/** Return the oldest bounded page of archive rows that still need object storage. */
export async function listPendingArchives(
  ctx: PlaneStorageCtx,
  limit: number,
): Promise<ArchiveMetadata[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 25));
  const pending = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.archives,
      IndexName: ARCHIVE_RETRY_INDEX,
      KeyConditionExpression: "retryState = :pending",
      ExpressionAttributeValues: { ":pending": "pending" },
      Limit: boundedLimit,
      ScanIndexForward: true,
    }),
  );
  const staleBefore = new Date(Date.now() - 55_000).toISOString();
  const processing = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.archives,
      IndexName: ARCHIVE_RETRY_INDEX,
      KeyConditionExpression: "retryState = :processing AND retryOrder < :staleBefore",
      ExpressionAttributeValues: { ":processing": "processing", ":staleBefore": staleBefore },
      Limit: boundedLimit,
      ScanIndexForward: true,
    }),
  );
  return catalogPageItems([
    ...(pending.Items ?? []),
    ...(processing.Items ?? []),
  ] as ArchiveMetadata[])
    .toSorted((left, right) =>
      (left.retryOrder ?? left.key).localeCompare(right.retryOrder ?? right.key),
    )
    .slice(0, boundedLimit);
}

/** Atomically move a pending archive out of the retry queue for one Cron worker. */
export async function claimArchiveRetry(
  ctx: PlaneStorageCtx,
  key: string,
  retryState: "pending" | "processing",
  retryOrder: string,
  claimedOrder: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.archives,
        Key: { key },
        UpdateExpression: "SET retryState = :processing, retryOrder = :claimed",
        ConditionExpression:
          "objectStored = :false AND retryState = :expectedState AND retryOrder = :expected",
        ExpressionAttributeValues: {
          ":false": false,
          ":processing": "processing",
          ":expectedState": retryState,
          ":expected": retryOrder,
          ":claimed": claimedOrder,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

/** Return a failed or expired claim to the pending queue only if its fence matches. */
export async function releaseArchiveRetry(
  ctx: PlaneStorageCtx,
  key: string,
  claimedOrder: string,
  retryOrder: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.archives,
        Key: { key },
        UpdateExpression: "SET retryState = :pending, retryOrder = :retryOrder",
        ConditionExpression:
          "objectStored = :false AND retryState = :processing AND retryOrder = :claimed",
        ExpressionAttributeValues: {
          ":false": false,
          ":processing": "processing",
          ":pending": "pending",
          ":claimed": claimedOrder,
          ":retryOrder": retryOrder,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

/** Complete an upload only while the worker still owns the retry fence. */
export async function completeArchiveRetry(
  ctx: PlaneStorageCtx,
  archive: ArchiveMetadata,
  expectedRetryOrder: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.archives,
        Key: { key: archive.key },
        UpdateExpression:
          "SET contentType = :contentType, bodyBytes = :bodyBytes, #status = :complete, objectStored = :true, updatedAt = :updatedAt" +
          (archive.objectKey ? ", objectKey = :objectKey" : "") +
          " REMOVE retryState, retryOrder",
        ConditionExpression:
          "objectStored = :false AND retryState = :processing AND retryOrder = :expected",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":contentType": archive.contentType,
          ":bodyBytes": archive.bodyBytes,
          ":complete": "complete",
          ":true": true,
          ":updatedAt": archive.updatedAt,
          ...(archive.objectKey ? { ":objectKey": archive.objectKey } : {}),
          ":false": false,
          ":processing": "processing",
          ":expected": expectedRetryOrder,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
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

/** Delete an inventory only if it is still the version its caller inspected. */
export async function deleteHostInventory(
  ctx: PlaneStorageCtx,
  hostId: string,
  expectedVersion?: number,
): Promise<boolean> {
  const input = {
    TableName: ctx.tables.hostInventories,
    Key: { hostId },
    ...inventoryVersionCondition(expectedVersion),
  };
  try {
    await ctx.doc.send(new DeleteCommand(input));
    return true;
  } catch (err) {
    return conditionalCatalogWriteOrThrow(err);
  }
}
