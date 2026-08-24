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
import type { SessionStatus } from "@auto-harness/shared";

import { statusShardAttr } from "./dynamo.ts";
import { getHostLock } from "./plane-storage-locks.ts";
import type { SessionRecord, WorktreeRecord } from "./types.ts";
import {
  itemToSession,
  isConditionalFailed,
  isConditionalTransactionFailed,
  isConditionalTransactionFailureAt,
  sessionToItem,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import {
  markerConditions,
  principalExistsCheck,
  withMarkerTable,
  type DeletionMarker,
} from "./plane-storage-deletion-markers.ts";
import { nextPageKey } from "./plane-storage-types.ts";
import {
  getSessionDrain,
  sessionDrainActivityPut,
  sessionDrainAdmissionCheck,
  sessionDrainCancellationUpdates,
} from "./plane-storage-session-drains.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityForScope,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";
import { sessionPrincipalId } from "../control-plane-session-owner.ts";
import { transitionEffect, type SessionTransitionPlan } from "../session-transition-planner.ts";

const MAX_CREATE_SESSION_ATTEMPTS = 3;
const SESSIONS_REPOSITORY_INDEX = "repositoryId-createdAt";

class SessionIdCollisionError extends Error {
  constructor(sessionId: string) {
    super(`session id collision: ${sessionId}`);
    this.name = "SessionIdCollisionError";
  }
}

class CreateSessionRetryExhaustedError extends Error {
  constructor(concurrencyId: string) {
    super(`could not resolve concurrency lock for ${concurrencyId}`);
    this.name = "CreateSessionRetryExhaustedError";
  }
}

class CatalogDeletionInProgressError extends Error {
  constructor() {
    super("catalog deletion is in progress");
    this.name = "CatalogDeletionInProgressError";
  }
}

class RepositoryAdmissionClosedError extends Error {
  constructor() {
    super("repository admission is closed");
    this.name = "RepositoryAdmissionClosedError";
  }
}

class SessionDrainActiveError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super("principal session admission is draining");
    this.name = "SessionDrainActiveError";
    this.operationId = operationId;
  }
}

export function isRepositoryAdmissionClosed(err: unknown): boolean {
  return err instanceof Error && err.name === "RepositoryAdmissionClosedError";
}

export function sessionDrainOperationId(err: unknown): string | null {
  return err instanceof SessionDrainActiveError ? err.operationId : null;
}

async function activeSessionDrainError(
  ctx: PlaneStorageCtx,
  session: SessionRecord,
): Promise<SessionDrainActiveError> {
  const principalId = sessionPrincipalId(session);
  const drain = principalId ? await getSessionDrain(ctx, session.repositoryId, principalId) : null;
  return new SessionDrainActiveError(drain?.operationId ?? "unknown");
}

export function isCreateSessionConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return [
    "SessionIdCollisionError",
    "CreateSessionRetryExhaustedError",
    "CatalogDeletionInProgressError",
  ].includes(err.name);
}

function waitForCreateSessionRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
}

export async function putSession(ctx: PlaneStorageCtx, session: SessionRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessions,
      Item: sessionToItem(session),
    }),
  );
}

export type CreateSessionResult =
  | { created: true; session: SessionRecord }
  | { created: false; session: SessionRecord };

/**
 * Create a session exactly once for a concurrency id.  The lock and session
 * rows are committed together, so separate control-plane processes cannot
 * both enqueue the same active task.
 */
export async function createSession(
  ctx: PlaneStorageCtx,
  session: SessionRecord,
  markers: readonly DeletionMarker[] = [],
): Promise<CreateSessionResult> {
  const drainCheck = sessionDrainAdmissionCheck(
    ctx,
    session.repositoryId,
    sessionPrincipalId(session),
  );
  const activityPut = sessionDrainActivityPut(ctx, session);
  const principalCheck = principalExistsCheck(ctx, sessionPrincipalId(session));
  if (!session.concurrencyId) {
    try {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            ...withMarkerTable(ctx, markerConditions([...markers])),
            ...(principalCheck ? [principalCheck] : []),
            {
              ConditionCheck: {
                TableName: ctx.tables.repositories,
                Key: { id: session.repositoryId },
                ConditionExpression:
                  "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)",
                ExpressionAttributeValues: { ":active": "active" },
              },
            },
            ...(drainCheck ? [drainCheck] : []),
            {
              Put: {
                TableName: ctx.tables.sessions,
                Item: sessionToItem(session),
                ConditionExpression: "attribute_not_exists(id)",
              },
            },
            ...(activityPut ? [activityPut] : []),
          ],
        }),
      );
    } catch (err) {
      if (isConditionalTransactionFailed(err)) {
        const principalIndex = markers.length;
        const repositoryIndex = principalIndex + Number(!!principalCheck);
        const drainIndex = repositoryIndex + 1;
        const sessionIndex = drainIndex + Number(!!drainCheck);
        if (
          (principalCheck && isConditionalTransactionFailureAt(err, principalIndex)) ||
          (markers.length &&
            Array.from({ length: markers.length }, (_, index) => index).some((index) =>
              isConditionalTransactionFailureAt(err, index),
            ))
        ) {
          throw new CatalogDeletionInProgressError();
        }
        if (isConditionalTransactionFailureAt(err, repositoryIndex)) {
          throw new RepositoryAdmissionClosedError();
        }
        if (drainCheck && isConditionalTransactionFailureAt(err, drainIndex)) {
          throw await activeSessionDrainError(ctx, session);
        }
        if (isConditionalTransactionFailureAt(err, sessionIndex)) {
          throw new SessionIdCollisionError(session.id);
        }
        throw new CatalogDeletionInProgressError();
      }
      throw err;
    }
    return { created: true, session };
  }

  for (let attempt = 0; attempt < MAX_CREATE_SESSION_ATTEMPTS; attempt += 1) {
    try {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            ...withMarkerTable(ctx, markerConditions([...markers])),
            ...(principalCheck ? [principalCheck] : []),
            {
              ConditionCheck: {
                TableName: ctx.tables.repositories,
                Key: { id: session.repositoryId },
                ConditionExpression:
                  "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)",
                ExpressionAttributeValues: { ":active": "active" },
              },
            },
            ...(drainCheck ? [drainCheck] : []),
            {
              Put: {
                TableName: ctx.tables.concurrencyLocks,
                Item: { concurrencyId: session.concurrencyId, sessionId: session.id },
                ConditionExpression: "attribute_not_exists(concurrencyId)",
              },
            },
            {
              Put: {
                TableName: ctx.tables.sessions,
                Item: sessionToItem(session),
                ConditionExpression: "attribute_not_exists(id)",
              },
            },
            ...(activityPut ? [activityPut] : []),
          ],
        }),
      );
      return { created: true, session };
    } catch (err) {
      if (!isConditionalTransactionFailed(err)) {
        throw err;
      }
      const markerCount = markers.length;
      if (
        markerCount &&
        [...Array(markerCount).keys()].some((index) =>
          isConditionalTransactionFailureAt(err, index),
        )
      ) {
        throw new CatalogDeletionInProgressError();
      }
      const principalIndex = markerCount;
      if (principalCheck && isConditionalTransactionFailureAt(err, principalIndex)) {
        throw new CatalogDeletionInProgressError();
      }
      const repositoryIndex = principalIndex + Number(!!principalCheck);
      if (isConditionalTransactionFailureAt(err, repositoryIndex)) {
        throw new RepositoryAdmissionClosedError();
      }
      const drainIndex = repositoryIndex + 1;
      if (drainCheck && isConditionalTransactionFailureAt(err, drainIndex)) {
        throw await activeSessionDrainError(ctx, session);
      }
      const lockIndex = drainIndex + Number(!!drainCheck);
      const lockConditionFailed = isConditionalTransactionFailureAt(err, lockIndex);
      const sessionIdConditionFailed = isConditionalTransactionFailureAt(err, lockIndex + 1);
      // When both conditions lose, the active lock is authoritative: it may
      // already own this same session ID and should still be returned as the
      // duplicate. A session-only collision can never succeed on retry.
      if (!lockConditionFailed && sessionIdConditionFailed) {
        throw new SessionIdCollisionError(session.id);
      }
      const lock = await getConcurrencyLock(ctx, session.concurrencyId);
      if (!lock) {
        if (sessionIdConditionFailed) throw new SessionIdCollisionError(session.id);
        if (attempt + 1 < MAX_CREATE_SESSION_ATTEMPTS) await waitForCreateSessionRetry(attempt);
        continue;
      }
      const current = await getSession(ctx, lock.sessionId, true);
      if (current && (current.status === "queued" || current.status === "running")) {
        return { created: false, session: current };
      }
      await releaseConcurrencyLock(ctx, session.concurrencyId, lock.sessionId);
      if (sessionIdConditionFailed) throw new SessionIdCollisionError(session.id);
      if (attempt + 1 < MAX_CREATE_SESSION_ATTEMPTS) await waitForCreateSessionRetry(attempt);
    }
  }
  throw new CreateSessionRetryExhaustedError(session.concurrencyId);
}

export async function getConcurrencyLock(
  ctx: PlaneStorageCtx,
  concurrencyId: string,
): Promise<{ sessionId: string } | null> {
  const res = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.concurrencyLocks,
      Key: { concurrencyId },
      ConsistentRead: true,
    }),
  );
  return res.Item && typeof res.Item.sessionId === "string"
    ? { sessionId: res.Item.sessionId }
    : null;
}

/** Delete only the lock owned by this session; stale owners cannot unlock newer work. */
export async function releaseConcurrencyLock(
  ctx: PlaneStorageCtx,
  concurrencyId: string,
  sessionId: string,
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId },
        ConditionExpression: "sessionId = :sessionId",
        ExpressionAttributeValues: { ":sessionId": sessionId },
      }),
    );
  } catch (err) {
    if (!isConditionalFailed(err)) throw err;
  }
}

export async function getSession(
  ctx: PlaneStorageCtx,
  id: string,
  consistentRead = false,
): Promise<SessionRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessions,
      Key: { id },
      ...(consistentRead ? { ConsistentRead: true } : {}),
    }),
  );
  return res.Item ? itemToSession(res.Item) : null;
}

export async function listAllSessions(
  ctx: PlaneStorageCtx,
  consistentRead = false,
): Promise<SessionRecord[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ...(consistentRead ? { ConsistentRead: true } : {}),
        TableName: ctx.tables.sessions,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return items.map(itemToSession);
}

/** Query the repository access path; callers apply the remaining filters locally. */
export async function listSessionsByRepository(
  ctx: PlaneStorageCtx,
  repositoryId: string,
): Promise<SessionRecord[]> {
  try {
    const records: SessionRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ctx.doc.send(
        new QueryCommand({
          TableName: ctx.tables.sessions,
          IndexName: SESSIONS_REPOSITORY_INDEX,
          KeyConditionExpression: "repositoryId = :repositoryId",
          ExpressionAttributeValues: { ":repositoryId": repositoryId },
          ScanIndexForward: true,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      records.push(
        ...(res.Items ?? []).map((item) => itemToSession(item as Record<string, unknown>)),
      );
      startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
    } while (startKey !== undefined);
    return records;
  } catch (error) {
    if (!isRepositoryIndexUnavailable(error)) throw error;
    return listSessionsByRepositoryScan(ctx, repositoryId);
  }
}

/** Count a repository's sessions without materializing its retained history. */
export async function countSessionsByRepository(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  hostId?: string,
): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessions,
        IndexName: SESSIONS_REPOSITORY_INDEX,
        KeyConditionExpression: "repositoryId = :repositoryId",
        ExpressionAttributeValues: {
          ":repositoryId": repositoryId,
          ...(hostId ? { ":hostId": hostId } : {}),
        },
        ...(hostId ? { FilterExpression: "hostId = :hostId" } : {}),
        Select: "COUNT",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    count += res.Count ?? 0;
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return count;
}

function isRepositoryIndexUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ValidationException"
  );
}

/** Compatibility path while an existing table's new GSI is being created. */
async function listSessionsByRepositoryScan(
  ctx: PlaneStorageCtx,
  repositoryId: string,
): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.sessions,
        FilterExpression: "repositoryId = :repositoryId",
        ExpressionAttributeValues: { ":repositoryId": repositoryId },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(
      ...(res.Items ?? []).map((item) => itemToSession(item as Record<string, unknown>)),
    );
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function listSessionsByStatus(
  ctx: PlaneStorageCtx,
  status: SessionStatus,
  shard: number,
): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessions,
        IndexName: "statusShard-createdAt",
        KeyConditionExpression: "statusShard = :ss",
        ExpressionAttributeValues: {
          ":ss": statusShardAttr(status, shard),
        },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...(res.Items ?? []).map((i) => itemToSession(i as Record<string, unknown>)));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function putWorktree(ctx: PlaneStorageCtx, wt: WorktreeRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.worktrees,
      Item: { ...wt },
    }),
  );
}

export async function deleteWorktree(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.worktrees, Key: { id } }));
}

/** Registration inventory is written only while its exact host lease is
 * current. This prevents an old API process from publishing stale inventory
 * after a replacement connection has won the host lock. */
export async function putWorktreeFenced(
  ctx: PlaneStorageCtx,
  wt: WorktreeRecord,
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
          {
            Put: {
              TableName: ctx.tables.worktrees,
              Item: { ...wt },
              // A registration inventory snapshot must never overwrite an
              // assigned worktree. Reconciliation owns that transition.
              ConditionExpression: "attribute_not_exists(id) OR #s <> :busy",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":busy": "busy" },
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

export async function getWorktree(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<WorktreeRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.worktrees, Key: { id } }));
  return (res.Item as WorktreeRecord | undefined) ?? null;
}

export async function listAllWorktrees(
  ctx: PlaneStorageCtx,
  consistentRead = false,
): Promise<WorktreeRecord[]> {
  const items: WorktreeRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ...(consistentRead ? { ConsistentRead: true } : {}),
        TableName: ctx.tables.worktrees,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as WorktreeRecord[]));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return items;
}

export async function listWorktreesForRepo(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  consistentRead = false,
): Promise<WorktreeRecord[]> {
  // The repository GSI is eventually consistent. Drain completion must not infer that a
  // lease is gone from a stale index, so use an authoritative base-table scan when requested.
  if (consistentRead) {
    return (await listAllWorktrees(ctx, true)).filter(
      (worktree) => worktree.repositoryId === repositoryId,
    );
  }
  const records: WorktreeRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.worktrees,
        IndexName: "repositoryId-id",
        KeyConditionExpression: "repositoryId = :r",
        ExpressionAttributeValues: { ":r": repositoryId },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as WorktreeRecord[]));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

/** Conditional claim (Invariant 1): idle + online → busy. */
export async function tryClaimWorktree(
  ctx: PlaneStorageCtx,
  opts: { worktreeId: string; sessionId: string; now: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.worktrees,
        Key: { id: opts.worktreeId },
        UpdateExpression: "SET #s = :busy, currentSessionId = :sid, lastAssignedAt = :now",
        ConditionExpression: "#s = :idle AND #o = :true",
        ExpressionAttributeNames: { "#s": "status", "#o": "online" },
        ExpressionAttributeValues: {
          ":busy": "busy",
          ":idle": "idle",
          ":true": true,
          ":sid": opts.sessionId,
          ":now": opts.now,
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
 * Atomically claim a worktree and move its session to running.
 *
 * The old control-plane path updated the two rows independently and queued the
 * writes, which allowed two hydrated API processes to both emit an assignment.
 * Keeping the condition on both rows makes the operation safe to retry: one
 * caller wins and the other observes a conditional failure without changing
 * either row.
 */
export async function tryAssignSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    repositoryId: string;
    worktreeId: string;
    hostId: string;
    hostInventoryVersion: number | null;
    principalId?: string;
    connectionId: string;
    now: string;
    attemptId: string;
    resolvedArgv: string[];
    resumeSpec?: import("@auto-harness/shared").SessionResumeSpec;
    resolvedRoute: SessionRecord["resolvedRoute"];
    providerAccountId?: string;
    queueShard: number;
  },
): Promise<boolean> {
  const sessionSets = [
    "#s = :running",
    "statusShard = :statusShard",
    "worktreeId = :wid",
    "hostId = :hid",
    "startedAt = :now",
    "attemptId = :attemptId",
    "resolvedArgv = :argv",
    "resolvedRoute = :route",
    "assignmentConnectionId = :connectionId",
  ];
  const sessionValues: Record<string, unknown> = {
    ":running": "running",
    ":statusShard": statusShardAttr("running", opts.queueShard),
    ":queued": "queued",
    ":wid": opts.worktreeId,
    ":hid": opts.hostId,
    ":now": opts.now,
    ":attemptId": opts.attemptId,
    ":argv": opts.resolvedArgv,
    ":connectionId": opts.connectionId,
    ":route": opts.resolvedRoute,
  };
  if (opts.resumeSpec !== undefined) {
    sessionSets.push("resumeSpec = if_not_exists(resumeSpec, :resumeSpec)");
    sessionValues[":resumeSpec"] = opts.resumeSpec;
  }
  const drainCheck = sessionDrainAdmissionCheck(ctx, opts.repositoryId, opts.principalId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.repositories,
              Key: { id: opts.repositoryId },
              ConditionExpression:
                "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)",
              ExpressionAttributeValues: { ":active": "active" },
            },
          },
          ...(drainCheck ? [drainCheck] : []),
          {
            ConditionCheck: {
              TableName: ctx.tables.hostInventories,
              Key: { hostId: opts.hostId },
              ConditionExpression:
                opts.hostInventoryVersion === null
                  ? "attribute_not_exists(hostId)"
                  : "version = :inventoryVersion OR (attribute_not_exists(version) AND :inventoryVersion = :zero)",
              ...(opts.hostInventoryVersion === null
                ? {}
                : {
                    ExpressionAttributeValues: {
                      ":inventoryVersion": opts.hostInventoryVersion,
                      ":zero": 0,
                    },
                  }),
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression:
                "SET #s = :busy, currentSessionId = :sid, lastAssignedAt = :now, connectionId = :connectionId",
              ConditionExpression: "#s = :idle AND #o = :true",
              ExpressionAttributeNames: { "#s": "status", "#o": "online" },
              ExpressionAttributeValues: {
                ":busy": "busy",
                ":idle": "idle",
                ":true": true,
                ":sid": opts.sessionId,
                ":now": opts.now,
                ":connectionId": opts.connectionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: `SET ${sessionSets.join(", ")} REMOVE ackReceivedAt, reconnectDeadlineAt`,
              ConditionExpression: "#s = :queued AND queueExpiresAt > :now",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: sessionValues,
            },
          },
          {
            // A hydrated scheduler can retain an online worktree after a
            // different process disconnects its host. The lease is the
            // authority for reachability, so require the exact connection
            // that was live when this candidate was selected.
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              ConditionExpression:
                "connectionId = :connectionId AND (attribute_not_exists(disconnected) OR disconnected = :false) AND (attribute_not_exists(draining) OR draining = :false)",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId, ":false": false },
            },
          },
          ...(opts.providerAccountId
            ? [
                {
                  Update: {
                    TableName: ctx.tables.providerAccounts,
                    Key: { id: opts.providerAccountId },
                    UpdateExpression: "SET lastAssignedAt = :now, updatedAt = :now",
                    ConditionExpression:
                      "attribute_exists(id) AND (attribute_not_exists(usageLimitedUntil) OR attribute_type(usageLimitedUntil, :nullType) OR usageLimitedUntil <= :now)",
                    ExpressionAttributeValues: { ":now": opts.now, ":nullType": "NULL" },
                  },
                },
              ]
            : []),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * A resume pin is a deadline, not a scheduling preference. Guard the failure
 * transition with the observed pin value so a concurrent retry/resume cannot
 * be overwritten by a scheduler that hydrated an older queued row.
 */
export async function failExpiredResumeSession(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; queueShard: number; pinExpiresAt: string; concurrencyId?: string },
): Promise<boolean> {
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :failed, statusShard = :statusShard, errorCode = :errorCode, errorMessage = :errorMessage",
              ConditionExpression: "#s = :queued AND pinExpiresAt = :pinExpiresAt",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":failed": "failed",
                ":statusShard": statusShardAttr("failed", opts.queueShard),
                ":errorCode": "resume_failed",
                ":errorMessage": "pin expired",
                ":queued": "queued",
                ":pinExpiresAt": opts.pinExpiresAt,
              },
            },
          },
          ...(opts.concurrencyId
            ? [
                {
                  Delete: {
                    TableName: ctx.tables.concurrencyLocks,
                    Key: { concurrencyId: opts.concurrencyId },
                    ConditionExpression:
                      "attribute_not_exists(concurrencyId) OR sessionId = :sessionId",
                    ExpressionAttributeValues: { ":sessionId": opts.sessionId },
                  },
                },
              ]
            : []),
          ...sessionDrainActivityDelete(ctx, before?.activity ?? null),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}

/** Atomically cancel queued work and release only the lock it owns. */
export async function cancelQueuedSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    queueShard: number;
    completedAt: string;
    errorMessage: string;
    concurrencyId?: string;
    drainOperationId?: string;
    drainRepositoryId?: string;
    drainPrincipalId?: string;
  },
): Promise<boolean> {
  const before = opts.drainOperationId ? null : await readSessionDrainActivity(ctx, opts.sessionId);
  const activity =
    opts.drainOperationId && opts.drainRepositoryId && opts.drainPrincipalId
      ? sessionDrainActivityForScope(opts.drainRepositoryId, opts.drainPrincipalId, opts.sessionId)
      : (before?.activity ?? null);
  const drainUpdate = opts.drainOperationId
    ? ", cancelledByDrainOperationId = :drainOperationId"
    : "";
  const items: Array<Record<string, unknown>> = [
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: `SET #s = :cancelled, statusShard = :statusShard, completedAt = :completedAt, errorMessage = :errorMessage, worktreeId = :null, hostId = :null${drainUpdate} REMOVE reconnectDeadlineAt, assignmentConnectionId`,
        ConditionExpression: "#s = :queued",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":cancelled": "cancelled",
          ":queued": "queued",
          ":statusShard": statusShardAttr("cancelled", opts.queueShard),
          ":completedAt": opts.completedAt,
          ":errorMessage": opts.errorMessage,
          ":null": null,
          ...(opts.drainOperationId ? { ":drainOperationId": opts.drainOperationId } : {}),
        },
      },
    },
    ...(opts.concurrencyId
      ? [
          {
            Delete: {
              TableName: ctx.tables.concurrencyLocks,
              Key: { concurrencyId: opts.concurrencyId },
              ConditionExpression: "attribute_not_exists(concurrencyId) OR sessionId = :sessionId",
              ExpressionAttributeValues: { ":sessionId": opts.sessionId },
            },
          },
        ]
      : []),
    ...sessionDrainActivityDelete(ctx, activity),
    ...(opts.drainOperationId && opts.drainRepositoryId && opts.drainPrincipalId
      ? sessionDrainCancellationUpdates(ctx, {
          repositoryId: opts.drainRepositoryId,
          principalId: opts.drainPrincipalId,
          operationId: opts.drainOperationId,
        })
      : []),
  ];
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

/** Mark one exact running worktree assignment cancelled while retaining its lease for terminal ack. */
export async function cancelRunningSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    hostId: string;
    connectionId: string;
    attemptId: string;
    queueShard: number;
    completedAt: string;
    errorMessage: string;
    drainOperationId?: string;
    drainRepositoryId?: string;
    drainPrincipalId?: string;
  },
): Promise<boolean> {
  const drainUpdate = opts.drainOperationId
    ? ", cancelledByDrainOperationId = :drainOperationId"
    : "";
  try {
    const update = {
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      UpdateExpression: `SET #s = :cancelled, statusShard = :statusShard, completedAt = :completedAt, errorMessage = :errorMessage${drainUpdate}`,
      ConditionExpression:
        "#s = :running AND worktreeId = :worktreeId AND hostId = :hostId AND assignmentConnectionId = :connectionId AND attemptId = :attemptId",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":running": "running",
        ":cancelled": "cancelled",
        ":statusShard": statusShardAttr("cancelled", opts.queueShard),
        ":completedAt": opts.completedAt,
        ":errorMessage": opts.errorMessage,
        ":worktreeId": opts.worktreeId,
        ":hostId": opts.hostId,
        ":connectionId": opts.connectionId,
        ":attemptId": opts.attemptId,
        ...(opts.drainOperationId ? { ":drainOperationId": opts.drainOperationId } : {}),
      },
    };
    if (opts.drainOperationId && opts.drainRepositoryId && opts.drainPrincipalId) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Update: update },
            ...sessionDrainCancellationUpdates(ctx, {
              repositoryId: opts.drainRepositoryId,
              principalId: opts.drainPrincipalId,
              operationId: opts.drainOperationId,
            }),
          ],
        }),
      );
    } else await ctx.doc.send(new UpdateCommand(update));
    return true;
  } catch (error) {
    if (isConditionalFailed(error) || isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}

/**
 * Persist the transition from a native-resume attempt to a fresh queued run.
 * The observed host is conditional so an older scheduler cannot erase a pin
 * installed by a newer resume request.
 */
export async function clearResumePin(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; pinnedHostId: string; pinExpiresAt?: string | undefined },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression:
          "SET resumeFallback = :true REMOVE pinnedHostId, pinnedProviderAccountId, pinnedTargetIndex, pinnedCommandId, pinExpiresAt, cliResumeRef",
        ConditionExpression:
          "#s = :queued AND pinnedHostId = :pinnedHostId" +
          (opts.pinExpiresAt === undefined ? "" : " AND pinExpiresAt = :pinExpiresAt"),
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":true": true,
          ":queued": "queued",
          ":pinnedHostId": opts.pinnedHostId,
          ...(opts.pinExpiresAt === undefined ? {} : { ":pinExpiresAt": opts.pinExpiresAt }),
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) return false;
    throw err;
  }
}

/**
 * A running session cancelled by an operator deliberately keeps its worktree
 * busy until the agent reports a terminal status. Release that exact claim
 * without changing the cancelled status, and detach the terminal session so a
 * duplicate late report is an idempotent no-op.
 */
export async function releaseCancelledSessionWorktree(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    /** A late terminal report from a healthy socket frees the worktree for
     * another assignment; only disconnect cleanup offlines it. */
    online: boolean;
    cliResumeRef?: string | undefined;
    fence?: { hostId: string; connectionId: string } | undefined;
    attemptId: string;
    concurrencyId?: string | undefined;
  },
): Promise<boolean> {
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  // A drain-owned cancellation remains in the ledger until its operation has
  // reconciled it. Ordinary cancellations are terminal activity and can go.
  const cleanup = before?.session.cancelledByDrainOperationId
    ? []
    : sessionDrainActivityDelete(ctx, before?.activity ?? null);
  // If a drain cancellation won after the strong pre-read, do not let this
  // terminal release delete the member its drain still needs to reconcile.
  // The caller will retry from the newly durable cancellation state.
  const requireNoDrainCancellation = cleanup.length > 0;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(opts.fence
            ? [
                {
                  ConditionCheck: {
                    TableName: ctx.tables.hostLocks,
                    Key: { hostId: opts.fence.hostId },
                    ConditionExpression: "connectionId = :connectionId",
                    ExpressionAttributeValues: { ":connectionId": opts.fence.connectionId },
                  },
                },
              ]
            : []),
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                `SET worktreeId = :null${opts.cliResumeRef ? ", cliResumeRef = :cliResumeRef" : ""} ` +
                "REMOVE assignmentConnectionId, reconnectDeadlineAt",
              ConditionExpression:
                "#s = :cancelled AND worktreeId = :worktreeId AND attemptId = :attemptId" +
                (requireNoDrainCancellation
                  ? " AND attribute_not_exists(cancelledByDrainOperationId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":cancelled": "cancelled",
                ":null": null,
                ":worktreeId": opts.worktreeId,
                ...(opts.cliResumeRef ? { ":cliResumeRef": opts.cliResumeRef } : {}),
                ":attemptId": opts.attemptId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
              ConditionExpression:
                "currentSessionId = :sid" +
                (opts.fence
                  ? " AND (attribute_not_exists(connectionId) OR connectionId = :connectionId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status", "#o": "online" },
              ExpressionAttributeValues: {
                ":idle": "idle",
                ":null": null,
                ":sid": opts.sessionId,
                ":online": opts.online,
                ...(opts.fence ? { ":connectionId": opts.fence.connectionId } : {}),
              },
            },
          },
          ...(opts.concurrencyId
            ? [
                {
                  Delete: {
                    TableName: ctx.tables.concurrencyLocks,
                    Key: { concurrencyId: opts.concurrencyId },
                    ConditionExpression:
                      "attribute_not_exists(concurrencyId) OR sessionId = :sessionId",
                    ExpressionAttributeValues: { ":sessionId": opts.sessionId },
                  },
                },
              ]
            : []),
          ...cleanup,
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      // The only new value that can make the cleanup fence fail is a drain
      // cancellation written after `before`. Re-read it and retry without the
      // ACT delete, so the late terminal still frees the worktree.
      if (requireNoDrainCancellation) {
        const current = await readSessionDrainActivity(ctx, opts.sessionId);
        if (current?.session.cancelledByDrainOperationId) {
          return releaseCancelledSessionWorktree(ctx, opts);
        }
      }
      const current = await getSession(ctx, opts.sessionId);
      return current?.status === "cancelled" && current.worktreeId == null;
    }
    throw err;
  }
}

/** Atomically release a worktree and requeue its running session. */
export async function tryRequeueSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    queueShard: number;
    reason?: string;
    forceOffline?: boolean;
    expectedHostId?: string;
    expectedReconnectDeadlineAt?: string;
    expectedConnectionId?: string;
    nextConnectionId?: string;
    requireNoHostLock?: string;
    fence?: { hostId: string; connectionId: string };
    requireUnacknowledged?: boolean;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(opts.fence
            ? [
                {
                  ConditionCheck: {
                    TableName: ctx.tables.hostLocks,
                    Key: { hostId: opts.fence.hostId },
                    ConditionExpression: "connectionId = :connectionId",
                    ExpressionAttributeValues: { ":connectionId": opts.fence.connectionId },
                  },
                },
              ]
            : []),
          ...(opts.requireNoHostLock
            ? [
                {
                  ConditionCheck: {
                    TableName: ctx.tables.hostLocks,
                    Key: { hostId: opts.requireNoHostLock },
                    ConditionExpression: "attribute_not_exists(hostId)",
                  },
                },
              ]
            : []),
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression:
                "SET #s = :idle, currentSessionId = :null, #o = :online" +
                (opts.nextConnectionId ? ", connectionId = :nextConnectionId" : ""),
              ConditionExpression:
                "currentSessionId = :sid" +
                (opts.expectedConnectionId
                  ? " AND (attribute_not_exists(connectionId) OR connectionId = :connectionId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status", "#o": "online" },
              ExpressionAttributeValues: {
                ":idle": "idle",
                ":null": null,
                ":online": opts.forceOffline !== true,
                ":sid": opts.sessionId,
                ...(opts.expectedConnectionId
                  ? { ":connectionId": opts.expectedConnectionId }
                  : {}),
                ...(opts.nextConnectionId ? { ":nextConnectionId": opts.nextConnectionId } : {}),
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, worktreeId = :null, hostId = :null, errorMessage = :reason REMOVE startedAt, ackReceivedAt, reconnectDeadlineAt, assignmentConnectionId",
              ConditionExpression:
                "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId" +
                (opts.requireUnacknowledged ? " AND attribute_not_exists(ackReceivedAt)" : "") +
                (opts.expectedHostId ? " AND hostId = :hostId" : "") +
                (opts.expectedReconnectDeadlineAt
                  ? " AND reconnectDeadlineAt = :reconnectDeadlineAt"
                  : "") +
                (opts.expectedConnectionId
                  ? " AND (attribute_not_exists(assignmentConnectionId) OR assignmentConnectionId = :connectionId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":running": "running",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":null": null,
                ":reason": opts.reason ?? "agent disconnected; requeued",
                ...(opts.expectedHostId ? { ":hostId": opts.expectedHostId } : {}),
                ...(opts.expectedReconnectDeadlineAt
                  ? { ":reconnectDeadlineAt": opts.expectedReconnectDeadlineAt }
                  : {}),
                ...(opts.expectedConnectionId
                  ? { ":connectionId": opts.expectedConnectionId }
                  : {}),
                ":worktreeId": opts.worktreeId,
                ":attemptId": opts.attemptId,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}

/** Idempotent acknowledgement of an assigned running session. */
export async function acknowledgeSession(
  ctx: PlaneStorageCtx,
  sessionId: string,
  acknowledgedAt: string,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean>;
export async function acknowledgeSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string | null;
    attemptId: string;
    acknowledgedAt: string;
    fence?: { hostId: string; connectionId: string };
  },
): Promise<boolean>;
export async function acknowledgeSession(
  ctx: PlaneStorageCtx,
  arg:
    | string
    | {
        sessionId: string;
        worktreeId: string | null;
        attemptId: string;
        acknowledgedAt: string;
        fence?: { hostId: string; connectionId: string };
      },
  acknowledgedAt?: string,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean> {
  const legacy = typeof arg === "string";
  const sessionId = legacy ? arg : arg.sessionId;
  const attempt = legacy ? null : arg;
  const activeFence = legacy ? fence : arg.fence;
  try {
    if (activeFence) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.tables.hostLocks,
                Key: { hostId: activeFence.hostId },
                ConditionExpression: "connectionId = :connectionId",
                ExpressionAttributeValues: { ":connectionId": activeFence.connectionId },
              },
            },
            {
              Update: {
                TableName: ctx.tables.sessions,
                Key: { id: sessionId },
                UpdateExpression: "SET ackReceivedAt = :at REMOVE assignmentSentAt",
                ConditionExpression:
                  "#s = :running" +
                  (attempt ? " AND worktreeId = :worktreeId AND attemptId = :attemptId" : "") +
                  " AND attribute_not_exists(ackReceivedAt)",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":at": attempt?.acknowledgedAt ?? acknowledgedAt,
                  ":running": "running",
                  ...(attempt
                    ? { ":worktreeId": attempt.worktreeId, ":attemptId": attempt.attemptId }
                    : {}),
                },
              },
            },
          ],
        }),
      );
      return true;
    }
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: sessionId },
        UpdateExpression: "SET ackReceivedAt = :at REMOVE assignmentSentAt",
        ConditionExpression:
          "#s = :running" +
          (attempt !== null ? " AND worktreeId = :worktreeId AND attemptId = :attemptId" : "") +
          " AND attribute_not_exists(ackReceivedAt)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":at": attempt?.acknowledgedAt ?? acknowledgedAt!,
          ":running": "running",
          ...(attempt !== null
            ? { ":worktreeId": attempt.worktreeId, ":attemptId": attempt.attemptId }
            : {}),
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      // A duplicate ack is a successful no-op, while a late ack for a terminal
      // session is also harmless to the caller.
      const current = await getSession(ctx, sessionId);
      const fenceStillOwnsHost =
        !activeFence || (await getHostLock(ctx, activeFence.hostId)) === activeFence.connectionId;
      if (legacy && activeFence) {
        return (
          current?.ackReceivedAt !== undefined &&
          current.status === "running" &&
          fenceStillOwnsHost &&
          current.hostId === activeFence.hostId &&
          (current.assignmentConnectionId === undefined ||
            current.assignmentConnectionId === activeFence.connectionId)
        );
      }
      const attemptMatches =
        !attempt ||
        (current?.worktreeId === attempt.worktreeId && current.attemptId === attempt.attemptId);
      const fenceMatches =
        !activeFence ||
        (current?.hostId === activeFence.hostId &&
          (current.assignmentConnectionId === undefined ||
            current.assignmentConnectionId === activeFence.connectionId));
      return legacy
        ? current?.ackReceivedAt !== undefined || current?.status !== "running"
        : current?.status === "running" &&
            attemptMatches &&
            fenceStillOwnsHost &&
            fenceMatches &&
            current.ackReceivedAt !== undefined;
    }
    throw err;
  }
}

/** Atomically apply a terminal transition and release its worktree. */
export async function finishSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId?: string | null;
    attemptId: string;
    status: string;
    queueShard: number;
    completedAt?: string;
    errorCode?: string;
    errorMessage?: string;
    exitCode?: number | null;
    cliResumeRef?: string;
    fence?: { hostId: string; connectionId: string };
    concurrencyId?: string;
  },
): Promise<boolean> {
  const before =
    opts.status === "queued" ? null : await readSessionDrainActivity(ctx, opts.sessionId);
  const cleanup =
    opts.status === "queued" || before?.session.cancelledByDrainOperationId
      ? []
      : sessionDrainActivityDelete(ctx, before?.activity ?? null);
  const values: Record<string, unknown> = {
    ":status": opts.status,
    ":statusShard": statusShardAttr(opts.status, opts.queueShard),
    ":running": "running",
    ":null": null,
  };
  const names: Record<string, string> = { "#s": "status" };
  const sets = [
    "#s = :status",
    "statusShard = :statusShard",
    "worktreeId = :null",
    ...(opts.status === "queued" ? ["hostId = :null"] : []),
  ];
  const removes = ["reconnectDeadlineAt", "assignmentConnectionId"];
  if (opts.completedAt !== undefined) {
    sets.push("completedAt = :completedAt");
    values[":completedAt"] = opts.completedAt;
  }
  if (opts.errorCode !== undefined) {
    sets.push("errorCode = :errorCode");
    values[":errorCode"] = opts.errorCode;
  }
  if (opts.errorMessage !== undefined) {
    sets.push("errorMessage = :errorMessage");
    values[":errorMessage"] = opts.errorMessage;
  }
  if (opts.exitCode !== undefined) {
    sets.push("exitCode = :exitCode");
    values[":exitCode"] = opts.exitCode;
  }
  if (opts.cliResumeRef !== undefined) {
    sets.push("cliResumeRef = :cliResumeRef");
    values[":cliResumeRef"] = opts.cliResumeRef;
  }
  const transactItems: Array<Record<string, unknown>> = [
    ...(opts.fence
      ? [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.fence.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.fence.connectionId },
            },
          },
        ]
      : []),
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: `SET ${sets.join(", ")} REMOVE ${removes.join(", ")}`,
        ConditionExpression:
          "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
  ];
  values[":worktreeId"] = opts.worktreeId ?? null;
  values[":attemptId"] = opts.attemptId;
  if (opts.worktreeId) {
    transactItems.push({
      Update: {
        TableName: ctx.tables.worktrees,
        Key: { id: opts.worktreeId },
        UpdateExpression: "SET #s = :idle, currentSessionId = :null",
        ConditionExpression: "currentSessionId = :sid",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":idle": "idle", ":null": null, ":sid": opts.sessionId },
      },
    });
  }
  if (opts.concurrencyId && opts.status !== "queued") {
    transactItems.push({
      Delete: {
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: opts.concurrencyId },
        ConditionExpression: "sessionId = :sessionId",
        ExpressionAttributeValues: { ":sessionId": opts.sessionId },
      },
    });
  }
  transactItems.push(...cleanup);
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      const current = await getSession(ctx, opts.sessionId);
      if (current?.status === opts.status && cleanup.length) {
        await ctx.doc.send(new TransactWriteCommand({ TransactItems: cleanup }));
      }
      return current?.status === opts.status;
    }
    throw err;
  }
}

/** Conditionally expire a queued session without requiring a worktree lease. */
export async function expireQueuedSession(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; queueShard: number; queueExpiresAt: string; completedAt: string },
): Promise<boolean> {
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :failed, statusShard = :statusShard, completedAt = :completedAt, errorCode = :code, errorMessage = :message",
              ConditionExpression: "#s = :queued AND queueExpiresAt = :expiresAt",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":failed": "failed",
                ":statusShard": statusShardAttr("failed", opts.queueShard),
                ":completedAt": opts.completedAt,
                ":expiresAt": opts.queueExpiresAt,
                ":code": "queue_expired",
                ":message": "queue TTL expired before capacity became available",
              },
            },
          },
          ...sessionDrainActivityDelete(ctx, before?.activity ?? null),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

/** Atomically pause the assigned global account, free the worktree, and requeue the session. */
export async function requeueUsageLimitedSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    providerAccountId: string;
    queueShard: number;
    now: string;
    usageLimitedUntil: string;
    errorMessage?: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.providerAccounts,
              Key: { id: opts.providerAccountId },
              UpdateExpression:
                "SET usageLimitedUntil = :until, lastUsageLimitedAt = :now, updatedAt = :now",
              ConditionExpression: "attribute_exists(id)",
              ExpressionAttributeValues: { ":until": opts.usageLimitedUntil, ":now": opts.now },
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null",
              ConditionExpression: "currentSessionId = :sid",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":idle": "idle", ":null": null, ":sid": opts.sessionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, worktreeId = :null, hostId = :null, errorCode = :code, errorMessage = :message REMOVE startedAt, ackReceivedAt",
              ConditionExpression:
                "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":running": "running",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":null": null,
                ":code": "usage_limit",
                ":message": opts.errorMessage ?? "provider usage limit; requeued",
                ":worktreeId": opts.worktreeId,
                ":attemptId": opts.attemptId,
              },
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

/** Requeue a providerless command and remember that this target is exhausted for this session. */
export async function suppressProviderlessUsageLimit(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    queueShard: number;
    targetIndex: number;
    errorMessage?: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null",
              ConditionExpression: "currentSessionId = :sid",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":idle": "idle", ":null": null, ":sid": opts.sessionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, worktreeId = :null, hostId = :null, errorCode = :code, errorMessage = :message, suppressedTargetIndexes = list_append(if_not_exists(suppressedTargetIndexes, :empty), :index) REMOVE startedAt, ackReceivedAt",
              ConditionExpression:
                "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":running": "running",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":null": null,
                ":code": "usage_limit",
                ":message": opts.errorMessage ?? "providerless usage limit; trying fallback",
                ":empty": [],
                ":index": [opts.targetIndex],
                ":worktreeId": opts.worktreeId,
                ":attemptId": opts.attemptId,
              },
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

export async function releaseWorktree(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  opts?: { forceOffline?: boolean },
): Promise<void> {
  const wt = await getWorktree(ctx, worktreeId);
  if (!wt) {
    return;
  }
  const online = opts?.forceOffline ? false : wt.online;
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
      ExpressionAttributeNames: { "#s": "status", "#o": "online" },
      ExpressionAttributeValues: {
        ":idle": "idle",
        ":null": null,
        ":online": online,
      },
    }),
  );
}

export async function setWorktreeOnline(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  online: boolean,
): Promise<void> {
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #o = :o",
      ExpressionAttributeNames: { "#o": "online" },
      ExpressionAttributeValues: { ":o": online },
    }),
  );
}

export async function setWorktreeOnlineFenced(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  connectionId: string,
  online: boolean,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    if (fence) {
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
              Update: {
                TableName: ctx.tables.worktrees,
                Key: { id: worktreeId },
                UpdateExpression: "SET #o = :online",
                ConditionExpression:
                  "attribute_not_exists(connectionId) OR connectionId = :connectionId",
                ExpressionAttributeNames: { "#o": "online" },
                ExpressionAttributeValues: { ":online": online, ":connectionId": connectionId },
              },
            },
          ],
        }),
      );
    } else {
      await ctx.doc.send(
        new UpdateCommand({
          TableName: ctx.tables.worktrees,
          Key: { id: worktreeId },
          UpdateExpression: "SET #o = :online",
          ConditionExpression: "attribute_not_exists(connectionId) OR connectionId = :connectionId",
          ExpressionAttributeNames: { "#o": "online" },
          ExpressionAttributeValues: { ":online": online, ":connectionId": connectionId },
        }),
      );
    }
    return true;
  } catch (err) {
    if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

function reportFieldsFromPlan(plan: SessionTransitionPlan): {
  exitCode?: number | null;
  errorCode?: string;
  errorMessage?: string;
  cliResumeRef?: string;
} {
  const finish = transitionEffect(plan, "finish");
  const requeue = transitionEffect(plan, "requeue");
  const exitCode = finish?.exitCode !== undefined ? finish.exitCode : requeue?.exitCode;
  const errorCode = finish?.errorCode !== undefined ? finish.errorCode : requeue?.errorCode;
  const errorMessage =
    finish?.errorMessage !== undefined ? finish.errorMessage : requeue?.errorMessage;
  const cliResumeRef =
    finish?.cliResumeRef !== undefined ? finish.cliResumeRef : requeue?.cliResumeRef;
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
  };
}

/** Build finishSession arguments from finish/requeue effects. */
export function finishSessionOptsFromPlan(
  session: SessionRecord,
  plan: SessionTransitionPlan,
  extras: { attemptId: string; fence?: { hostId: string; connectionId: string } },
): Parameters<typeof finishSession>[1] {
  const finish = transitionEffect(plan, "finish");
  const queued = transitionEffect(plan, "requeue") !== undefined && finish === undefined;
  return {
    sessionId: session.id,
    worktreeId: session.worktreeId ?? null,
    attemptId: extras.attemptId,
    status: finish?.status ?? "queued",
    queueShard: session.queueShard,
    ...(queued || finish?.completedAt === undefined ? {} : { completedAt: finish.completedAt }),
    ...reportFieldsFromPlan(plan),
    ...(extras.fence ? { fence: extras.fence } : {}),
    ...(session.concurrencyId !== undefined ? { concurrencyId: session.concurrencyId } : {}),
  };
}

/** Map planner cooldown+requeue effects onto the usage-limit worktree write. */
export function requeueUsageLimitedSessionOptsFromPlan(
  session: SessionRecord,
  plan: SessionTransitionPlan,
  extras: { now: string; attemptId: string },
): Parameters<typeof requeueUsageLimitedSession>[1] {
  const cooldown = transitionEffect(plan, "cooldown")!;
  const requeue = transitionEffect(plan, "requeue");
  return {
    sessionId: session.id,
    worktreeId: session.worktreeId!,
    attemptId: extras.attemptId,
    providerAccountId: cooldown.providerAccountId,
    queueShard: session.queueShard,
    now: extras.now,
    usageLimitedUntil: cooldown.usageLimitedUntil,
    ...(requeue?.errorMessage ? { errorMessage: requeue.errorMessage } : {}),
  };
}

/** Map planner suppress+requeue effects onto the providerless usage-limit write. */
export function suppressProviderlessUsageLimitOptsFromPlan(
  session: SessionRecord,
  plan: SessionTransitionPlan,
  extras: { attemptId: string },
): Parameters<typeof suppressProviderlessUsageLimit>[1] {
  const suppress = transitionEffect(plan, "suppress_target")!;
  const requeue = transitionEffect(plan, "requeue");
  return {
    sessionId: session.id,
    worktreeId: session.worktreeId!,
    attemptId: extras.attemptId,
    queueShard: session.queueShard,
    targetIndex: suppress.targetIndex,
    ...(requeue?.errorMessage ? { errorMessage: requeue.errorMessage } : {}),
  };
}
