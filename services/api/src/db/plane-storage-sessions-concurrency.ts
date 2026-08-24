import { DeleteCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import {
  markerConditions,
  principalExistsCheck,
  withMarkerTable,
  type DeletionMarker,
} from "./plane-storage-deletion-markers.ts";
import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  isConditionalTransactionFailureAt,
  sessionToItem,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import {
  sessionDrainActivityPut,
  sessionDrainAdmissionCheck,
} from "./plane-storage-session-drains.ts";
import type { SessionRecord } from "./types.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import {
  activeSessionDrainError,
  CatalogDeletionInProgressError,
  CreateSessionRetryExhaustedError,
  type CreateSessionResult,
  RepositoryAdmissionClosedError,
  SessionIdCollisionError,
} from "./plane-storage-sessions-errors.ts";

const MAX_CREATE_SESSION_ATTEMPTS = 3;

type CreateSessionAdmissionParts = {
  drainCheck: ReturnType<typeof sessionDrainAdmissionCheck>;
  activityPut: ReturnType<typeof sessionDrainActivityPut>;
  principalCheck: ReturnType<typeof principalExistsCheck>;
};

async function throwIfCreateAdmissionConflict(
  ctx: PlaneStorageCtx,
  err: unknown,
  session: SessionRecord,
  markers: readonly DeletionMarker[],
  parts: CreateSessionAdmissionParts,
): Promise<void> {
  if (!isConditionalTransactionFailed(err)) throw err;
  const { drainCheck, principalCheck } = parts;
  if (
    markers.length > 0 &&
    Array.from({ length: markers.length }, (_, index) => index).some((index) =>
      isConditionalTransactionFailureAt(err, index),
    )
  ) {
    throw new CatalogDeletionInProgressError();
  }
  const principalIndex = markers.length;
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
}

async function resolveConcurrencyLockConflict(
  ctx: PlaneStorageCtx,
  err: unknown,
  session: SessionRecord,
  lockIndex: number,
): Promise<CreateSessionResult | "retry"> {
  const lockConditionFailed = isConditionalTransactionFailureAt(err, lockIndex);
  const sessionIdConditionFailed = isConditionalTransactionFailureAt(err, lockIndex + 1);
  // When both conditions lose, the active lock is authoritative: it may
  // already own this same session ID and should still be returned as the
  // duplicate. A session-only collision can never succeed on retry.
  if (!lockConditionFailed && sessionIdConditionFailed) {
    throw new SessionIdCollisionError(session.id);
  }
  const lock = await getConcurrencyLock(ctx, session.concurrencyId!);
  if (!lock) {
    if (sessionIdConditionFailed) throw new SessionIdCollisionError(session.id);
    return "retry";
  }
  const current = await getSession(ctx, lock.sessionId, true);
  if (current && (current.status === "queued" || current.status === "running")) {
    return { created: false, session: current };
  }
  await releaseConcurrencyLock(ctx, session.concurrencyId!, lock.sessionId);
  if (sessionIdConditionFailed) throw new SessionIdCollisionError(session.id);
  return "retry";
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

/** Commit the session row together with the exclusive concurrency lock. */
export async function createSessionWithConcurrency(
  ctx: PlaneStorageCtx,
  session: SessionRecord,
  markers: readonly DeletionMarker[],
  parts: CreateSessionAdmissionParts,
): Promise<CreateSessionResult> {
  const concurrencyId = session.concurrencyId!;
  const { drainCheck, activityPut, principalCheck } = parts;
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
                Item: { concurrencyId, sessionId: session.id },
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
      await throwIfCreateAdmissionConflict(ctx, err, session, markers, parts);
      const resolved = await resolveConcurrencyLockConflict(
        ctx,
        err,
        session,
        markers.length + Number(!!principalCheck) + 1 + Number(!!drainCheck),
      );
      if (resolved !== "retry") return resolved;
      if (attempt + 1 < MAX_CREATE_SESSION_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
      }
    }
  }
  throw new CreateSessionRetryExhaustedError(concurrencyId);
}
