import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { sessionDrainCancellationUpdates } from "./plane-storage-session-drains.ts";

type DrainCancelScope = {
  repositoryId: string;
  principalId: string;
  operationId: string;
};

type SessionCancelUpdate = {
  TableName: string;
  Key: Record<string, unknown>;
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
};

/** The one host push this cancel produces, recorded so cron can redeliver a lost one. */
type CancelRedeliveryMarker = {
  sessionId: string;
  hostId: string;
  attemptId: string;
  now: string;
};

export function drainCancelScope(opts: {
  drainOperationId?: string;
  drainRepositoryId?: string;
  drainPrincipalId?: string;
}): DrainCancelScope | undefined {
  if (!opts.drainOperationId || !opts.drainRepositoryId || !opts.drainPrincipalId) return undefined;
  return {
    repositoryId: opts.drainRepositoryId,
    principalId: opts.drainPrincipalId,
    operationId: opts.drainOperationId,
  };
}

export function drainCancelledByClause(drainOperationId?: string): string {
  return drainOperationId ? ", cancelledByDrainOperationId = :drainOperationId" : "";
}

/**
 * Write a cancelled session row, incrementing drain counters when this cancel belongs to a
 * drain. The redelivery marker for the one host push this cancel produces is written in the
 * same transaction: a separate best-effort write could fail after the cancellation already
 * committed, silently losing cron's only path to redeliver a dropped `session:cancel`.
 */
export async function writeCancelledSessionUpdate(
  ctx: PlaneStorageCtx,
  update: SessionCancelUpdate,
  redeliveryMarker: CancelRedeliveryMarker,
  drain?: DrainCancelScope,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: update },
          {
            Put: {
              TableName: ctx.tables.sessionCancelRedeliveries,
              Item: {
                sessionId: redeliveryMarker.sessionId,
                hostId: redeliveryMarker.hostId,
                attemptId: redeliveryMarker.attemptId,
                status: "pending",
                attempts: 0,
                createdAt: redeliveryMarker.now,
                queuedAt: redeliveryMarker.now,
                updatedAt: redeliveryMarker.now,
              },
            },
          },
          ...(drain ? sessionDrainCancellationUpdates(ctx, drain) : []),
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}
