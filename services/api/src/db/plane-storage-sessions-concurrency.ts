/* eslint-disable max-lines -- admission, parent, integration, lock, and session transaction indexes stay co-located. */
import {
  DeleteCommand,
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

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
  ParentSessionAttemptEndedError,
  SessionDescendantBudgetExceededError,
  type CreateSessionResult,
  IntegrationChangedError,
  RepositoryAdmissionClosedError,
  SessionIdCollisionError,
} from "./plane-storage-sessions-errors.ts";

const MAX_CREATE_SESSION_ATTEMPTS = 3;

type CreateSessionAdmissionParts = {
  drainCheck: ReturnType<typeof sessionDrainAdmissionCheck>;
  activityPut: ReturnType<typeof sessionDrainActivityPut>;
  principalCheck: ReturnType<typeof principalExistsCheck>;
  parentFence?: { id: string; rootSessionId?: string; sessionApiKeyHash?: string };
  integrationCheck?: NonNullable<TransactWriteCommandInput["TransactItems"]>[number] | undefined;
};

/** Conservative root-wide bound for direct and indirect child sessions. */
export const MAX_SESSION_DESCENDANTS = 64;

function hasSeparateParentCheck(parentFence: CreateSessionAdmissionParts["parentFence"]): boolean {
  return !!parentFence && parentFence.rootSessionId !== parentFence.id;
}

function parentFenceIsValid(
  parent: SessionRecord | null,
  parentFence: NonNullable<CreateSessionAdmissionParts["parentFence"]>,
): boolean {
  if (!parent) return false;
  if (parentFence.sessionApiKeyHash) {
    return (
      parent.status === "running" && parent.sessionApiKeyHash === parentFence.sessionApiKeyHash
    );
  }
  return ["running", "completed", "failed", "cancelled", "timed_out"].includes(parent.status);
}

async function throwIfCreateAdmissionConflict(
  ctx: PlaneStorageCtx,
  err: unknown,
  session: SessionRecord,
  markers: readonly DeletionMarker[],
  parts: CreateSessionAdmissionParts,
): Promise<void> {
  if (!isConditionalTransactionFailed(err)) throw err;
  const { drainCheck, principalCheck, integrationCheck } = parts;
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
  const resourceIndex = principalIndex + Number(!!principalCheck);
  if (isConditionalTransactionFailureAt(err, resourceIndex)) {
    if (session.repositoryId) throw new RepositoryAdmissionClosedError();
    throw new CatalogDeletionInProgressError();
  }
  const drainIndex = resourceIndex + 1;
  if (drainCheck && isConditionalTransactionFailureAt(err, drainIndex)) {
    throw await activeSessionDrainError(ctx, session);
  }
  const parentIndex = drainIndex + Number(!!drainCheck);
  if (
    hasSeparateParentCheck(parts.parentFence) &&
    isConditionalTransactionFailureAt(err, parentIndex)
  ) {
    throw new ParentSessionAttemptEndedError();
  }
  const integrationIndex = parentIndex + Number(hasSeparateParentCheck(parts.parentFence));
  if (integrationCheck && isConditionalTransactionFailureAt(err, integrationIndex)) {
    throw new IntegrationChangedError();
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
  const { drainCheck, activityPut, principalCheck, parentFence, integrationCheck } = parts;
  const separateParentCheck = hasSeparateParentCheck(parentFence);
  const markerChecks = withMarkerTable(ctx, markerConditions([...markers]));
  const parentCheck =
    parentFence && separateParentCheck
      ? {
          ConditionCheck: {
            TableName: ctx.tables.sessions,
            Key: { id: parentFence.id },
            ConditionExpression: parentFence.sessionApiKeyHash
              ? "#status = :running AND sessionApiKeyHash = :sessionApiKeyHash"
              : "#status IN (:running, :completed, :failed, :cancelled, :timedOut)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":running": "running",
              ...(parentFence.sessionApiKeyHash
                ? { ":sessionApiKeyHash": parentFence.sessionApiKeyHash }
                : {
                    ":completed": "completed",
                    ":failed": "failed",
                    ":cancelled": "cancelled",
                    ":timedOut": "timed_out",
                  }),
            },
          },
        }
      : null;
  const rootBudgetUpdate = parentFence?.rootSessionId
    ? {
        Update: {
          TableName: ctx.tables.sessions,
          Key: { id: parentFence.rootSessionId },
          UpdateExpression: "SET descendantCount = if_not_exists(descendantCount, :zero) + :one",
          ConditionExpression: [
            "attribute_exists(id)",
            ...(parentFence && !separateParentCheck
              ? [
                  parentFence.sessionApiKeyHash
                    ? "#status = :running AND sessionApiKeyHash = :sessionApiKeyHash"
                    : "#status IN (:running, :completed, :failed, :cancelled, :timedOut)",
                ]
              : []),
            "(attribute_not_exists(descendantCount) OR descendantCount < :max)",
          ].join(" AND "),
          ...(parentFence && !separateParentCheck
            ? { ExpressionAttributeNames: { "#status": "status" } }
            : {}),
          ExpressionAttributeValues: {
            ":zero": 0,
            ":one": 1,
            ":max": MAX_SESSION_DESCENDANTS,
            ...(parentFence && !separateParentCheck
              ? parentFence.sessionApiKeyHash
                ? { ":running": "running", ":sessionApiKeyHash": parentFence.sessionApiKeyHash }
                : {
                    ":running": "running",
                    ":completed": "completed",
                    ":failed": "failed",
                    ":cancelled": "cancelled",
                    ":timedOut": "timed_out",
                  }
              : {}),
          },
        },
      }
    : null;
  const fixedActionCount =
    markerChecks.length +
    Number(!!principalCheck) +
    1 +
    Number(!!drainCheck) +
    Number(!!parentCheck) +
    Number(!!integrationCheck) +
    2 +
    Number(!!activityPut) +
    Number(!!rootBudgetUpdate);
  if (fixedActionCount > 100) {
    throw new Error("child session admission exceeds DynamoDB's 100 transaction action limit");
  }
  const rootBudgetIndex = fixedActionCount - Number(!!rootBudgetUpdate);
  const lockIndex =
    markerChecks.length +
    Number(!!principalCheck) +
    1 +
    Number(!!drainCheck) +
    Number(!!parentCheck) +
    Number(!!integrationCheck);
  for (let attempt = 0; attempt < MAX_CREATE_SESSION_ATTEMPTS; attempt += 1) {
    try {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            ...markerChecks,
            ...(principalCheck ? [principalCheck] : []),
            session.repositoryId
              ? {
                  ConditionCheck: {
                    TableName: ctx.tables.repositories,
                    Key: { id: session.repositoryId },
                    ConditionExpression:
                      "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)",
                    ExpressionAttributeValues: { ":active": "active" },
                  },
                }
              : {
                  ConditionCheck: {
                    TableName: ctx.tables.workspacePools,
                    Key: { id: session.workspacePoolId },
                    ConditionExpression: "attribute_exists(id)",
                  },
                },
            ...(drainCheck ? [drainCheck] : []),
            ...(parentCheck ? [parentCheck] : []),
            ...(integrationCheck ? [integrationCheck] : []),
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
            ...(rootBudgetUpdate ? [rootBudgetUpdate] : []),
          ],
        }),
      );
      return { created: true, session };
    } catch (err) {
      await throwIfCreateAdmissionConflict(ctx, err, session, markers, parts);
      if (rootBudgetUpdate && isConditionalTransactionFailureAt(err, rootBudgetIndex)) {
        if (parentFence && !separateParentCheck) {
          const currentParent = await getSession(ctx, parentFence.id, true);
          if (!parentFenceIsValid(currentParent, parentFence)) {
            throw new ParentSessionAttemptEndedError();
          }
        }
        const resolved = await resolveConcurrencyLockConflict(ctx, err, session, lockIndex);
        if (resolved !== "retry") return resolved;
        throw new SessionDescendantBudgetExceededError();
      }
      const resolved = await resolveConcurrencyLockConflict(ctx, err, session, lockIndex);
      if (resolved !== "retry") return resolved;
      if (attempt + 1 < MAX_CREATE_SESSION_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
      }
    }
  }
  throw new CreateSessionRetryExhaustedError(concurrencyId);
}
