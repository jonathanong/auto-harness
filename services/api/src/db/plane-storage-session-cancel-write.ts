import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
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

/** Write a cancelled session row, incrementing drain counters when this cancel belongs to a drain. */
export async function writeCancelledSessionUpdate(
  ctx: PlaneStorageCtx,
  update: SessionCancelUpdate,
  drain?: DrainCancelScope,
): Promise<boolean> {
  try {
    if (drain) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [{ Update: update }, ...sessionDrainCancellationUpdates(ctx, drain)],
        }),
      );
    } else await ctx.doc.send(new UpdateCommand(update));
    return true;
  } catch (error) {
    if (isConditionalFailed(error) || isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}
