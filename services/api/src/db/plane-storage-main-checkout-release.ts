import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

type ReleaseMainCheckoutOptions = {
  sessionId: string;
  hostId: string;
  repositoryId: string;
  connectionId: string;
  status: string;
  queueShard: number;
  reason?: string | undefined;
  completedAt?: string | undefined;
  exitCode?: number | null | undefined;
  errorCode?: string | undefined;
  cliResumeRef?: string | undefined;
  retryCount?: number;
  retryAfter?: string;
  expectedStatus?: "running" | "cancelled";
  attemptId?: string;
  concurrencyId?: string | undefined;
  /** Used by the assignment ACK deadline only: do not release a run whose
   * acknowledgement committed after this scheduler read its local cache. */
  requireUnacknowledged?: boolean;
};

export async function releaseMainCheckoutSession(
  ctx: PlaneStorageCtx,
  opts: ReleaseMainCheckoutOptions,
): Promise<boolean> {
  const isQueued = opts.status === "queued";
  const before = isQueued ? null : await readSessionDrainActivity(ctx, opts.sessionId);
  const cleanup =
    isQueued || before?.session.cancelledByDrainOperationId
      ? []
      : sessionDrainActivityDelete(ctx, before?.activity ?? null);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression: "REMOVE mainCheckoutLeases.#repo",
              ConditionExpression:
                "mainCheckoutLeases.#repo.sessionId = :sessionId AND mainCheckoutLeases.#repo.connectionId = :connectionId",
              ExpressionAttributeNames: { "#repo": opts.repositoryId },
              ExpressionAttributeValues: {
                ":sessionId": opts.sessionId,
                ":connectionId": opts.connectionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: updateExpression(opts, isQueued),
              ConditionExpression:
                "#s = :expectedStatus AND hostId = :hostId AND assignmentConnectionId = :connectionId AND mainCheckoutLease = :true" +
                (opts.attemptId ? " AND attemptId = :attemptId" : "") +
                (opts.requireUnacknowledged ? " AND attribute_not_exists(ackReceivedAt)" : ""),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: expressionValues(opts),
            },
          },
          ...(opts.concurrencyId && !isQueued
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
  } catch (error) {
    if (isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}

function updateExpression(opts: ReleaseMainCheckoutOptions, isQueued: boolean): string {
  return (
    "SET #s = :status, statusShard = :statusShard, worktreeId = :null" +
    (isQueued ? ", hostId = :null" : "") +
    (opts.reason ? ", errorMessage = :reason" : "") +
    (opts.completedAt ? ", completedAt = :completedAt" : "") +
    (opts.exitCode !== undefined ? ", exitCode = :exitCode" : "") +
    (opts.errorCode ? ", errorCode = :errorCode" : "") +
    (opts.cliResumeRef ? ", cliResumeRef = :cliResumeRef" : "") +
    (opts.retryCount !== undefined ? ", retryCount = :retryCount" : "") +
    (opts.retryAfter ? ", retryAfter = :retryAfter" : "") +
    " REMOVE assignmentConnectionId, assignmentSentAt, reconnectDeadlineAt, mainCheckoutLease, ackReceivedAt" +
    (isQueued ? ", startedAt" : "")
  );
}

function expressionValues(opts: ReleaseMainCheckoutOptions): Record<string, unknown> {
  return {
    ":status": opts.status,
    ":statusShard": statusShardAttr(opts.status, opts.queueShard),
    ":expectedStatus": opts.expectedStatus ?? "running",
    ":hostId": opts.hostId,
    ":connectionId": opts.connectionId,
    ":true": true,
    ":null": null,
    ...(opts.reason ? { ":reason": opts.reason } : {}),
    ...(opts.completedAt ? { ":completedAt": opts.completedAt } : {}),
    ...(opts.exitCode !== undefined ? { ":exitCode": opts.exitCode } : {}),
    ...(opts.errorCode ? { ":errorCode": opts.errorCode } : {}),
    ...(opts.cliResumeRef ? { ":cliResumeRef": opts.cliResumeRef } : {}),
    ...(opts.retryCount !== undefined ? { ":retryCount": opts.retryCount } : {}),
    ...(opts.retryAfter ? { ":retryAfter": opts.retryAfter } : {}),
    ...(opts.attemptId ? { ":attemptId": opts.attemptId } : {}),
  };
}
