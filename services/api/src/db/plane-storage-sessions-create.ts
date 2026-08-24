import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import {
  markerConditions,
  principalExistsCheck,
  withMarkerTable,
  type DeletionMarker,
} from "./plane-storage-deletion-markers.ts";
import {
  isConditionalTransactionFailed,
  isConditionalTransactionFailureAt,
  sessionToItem,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import {
  sessionDrainActivityPut,
  sessionDrainAdmissionCheck,
} from "./plane-storage-session-drains.ts";
import { sessionPrincipalId } from "../control-plane-session-owner.ts";
import type { SessionRecord } from "./types.ts";
import { createSessionWithConcurrency } from "./plane-storage-sessions-concurrency.ts";
import {
  activeSessionDrainError,
  CatalogDeletionInProgressError,
  type CreateSessionResult,
  RepositoryAdmissionClosedError,
  SessionIdCollisionError,
} from "./plane-storage-sessions-errors.ts";

export async function putSession(ctx: PlaneStorageCtx, session: SessionRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessions,
      Item: sessionToItem(session),
    }),
  );
}

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
  if (session.concurrencyId) {
    return createSessionWithConcurrency(ctx, session, markers, {
      drainCheck,
      activityPut,
      principalCheck,
    });
  }
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
