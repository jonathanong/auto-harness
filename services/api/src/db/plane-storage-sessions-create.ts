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
  type IntegrationSessionFence,
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
  IntegrationChangedError,
  RepositoryAdmissionClosedError,
  SessionIdCollisionError,
} from "./plane-storage-sessions-errors.ts";

function integrationSessionFenceCheck(
  ctx: PlaneStorageCtx,
  fence: IntegrationSessionFence | undefined,
) {
  if (!fence) return undefined;
  return {
    ConditionCheck: {
      TableName: ctx.tables.integrations,
      Key: { id: fence.storageId },
      ConditionExpression:
        "attribute_exists(id) AND #type = :type AND #version = :version AND #enabled = :enabled",
      ExpressionAttributeNames: { "#type": "type", "#version": "version", "#enabled": "enabled" },
      ExpressionAttributeValues: {
        ":type": fence.type,
        ":version": fence.version,
        ":enabled": fence.enabled,
      },
    },
  };
}

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
async function throwCreateSessionTransactionFailure(
  ctx: PlaneStorageCtx,
  err: unknown,
  session: SessionRecord,
  markers: readonly DeletionMarker[],
  principalCheck: ReturnType<typeof principalExistsCheck>,
  drainCheck: ReturnType<typeof sessionDrainAdmissionCheck>,
  integrationCheck: ReturnType<typeof integrationSessionFenceCheck>,
): Promise<never> {
  if (!isConditionalTransactionFailed(err)) throw err;
  const principalIndex = markers.length;
  const resourceIndex = principalIndex + Number(!!principalCheck);
  const drainIndex = resourceIndex + 1;
  const integrationIndex = drainIndex + Number(!!drainCheck);
  const sessionIndex = integrationIndex + Number(!!integrationCheck);
  const markerFailed =
    markers.length > 0 &&
    Array.from({ length: markers.length }, (_, index) => index).some((index) =>
      isConditionalTransactionFailureAt(err, index),
    );
  if ((principalCheck && isConditionalTransactionFailureAt(err, principalIndex)) || markerFailed) {
    throw new CatalogDeletionInProgressError();
  }
  if (isConditionalTransactionFailureAt(err, resourceIndex)) {
    if (session.repositoryId) throw new RepositoryAdmissionClosedError();
    throw new CatalogDeletionInProgressError();
  }
  if (drainCheck && isConditionalTransactionFailureAt(err, drainIndex)) {
    throw await activeSessionDrainError(ctx, session);
  }
  if (integrationCheck && isConditionalTransactionFailureAt(err, integrationIndex)) {
    throw new IntegrationChangedError();
  }
  if (isConditionalTransactionFailureAt(err, sessionIndex)) {
    throw new SessionIdCollisionError(session.id);
  }
  throw new CatalogDeletionInProgressError();
}

export async function createSession(
  ctx: PlaneStorageCtx,
  session: SessionRecord,
  markers: readonly DeletionMarker[] = [],
  parentFence?: { id: string; rootSessionId?: string; sessionApiKeyHash?: string },
  integrationFence?: IntegrationSessionFence,
): Promise<CreateSessionResult> {
  const drainCheck = session.repositoryId
    ? sessionDrainAdmissionCheck(ctx, session.repositoryId, sessionPrincipalId(session))
    : null;
  const activityPut = session.repositoryId ? sessionDrainActivityPut(ctx, session) : null;
  const principalCheck = principalExistsCheck(ctx, sessionPrincipalId(session));
  const integrationCheck = integrationSessionFenceCheck(ctx, integrationFence);
  if (session.concurrencyId) {
    return createSessionWithConcurrency(ctx, session, markers, {
      drainCheck,
      activityPut,
      principalCheck,
      ...(parentFence ? { parentFence } : {}),
      integrationCheck,
    });
  }
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...withMarkerTable(ctx, markerConditions([...markers])),
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
          ...(integrationCheck ? [integrationCheck] : []),
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
    await throwCreateSessionTransactionFailure(
      ctx,
      err,
      session,
      markers,
      principalCheck,
      drainCheck,
      integrationCheck,
    );
  }
  return { created: true, session };
}
