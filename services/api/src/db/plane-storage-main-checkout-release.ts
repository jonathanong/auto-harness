import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { queueOrderKeyForWrite } from "../control-plane-ordering.ts";
import { statusShardAttr } from "./dynamo.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";
import {
  providerAccountLeaseDeleteItems,
  type ProviderAccountLeaseKey,
} from "./plane-storage-provider-account-leases.ts";
import type { HostAssignmentLease } from "./plane-storage-host-assignment.ts";
import {
  isConditionalTransactionFailed,
  itemToSession,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";

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
  suppressedTargetIndex?: number;
  queueOrder?: string;
  expectedStatus?: "running" | "cancelled";
  attemptId?: string;
  concurrencyId?: string | undefined;
  /** Used by the assignment ACK deadline only: do not release a run whose
   * acknowledgement committed after this scheduler read its local cache. */
  requireUnacknowledged?: boolean;
  providerAccountLease?: ProviderAccountLeaseKey | undefined;
  hostAssignmentLease?: HostAssignmentLease | undefined;
  /** Timeout keeps the slot until the daemon reports terminal or disconnect recovery. */
  preserveProviderAccountLease?: boolean;
  /** Timeout keeps host capacity until terminal/disconnect cleanup. */
  preserveHostAssignmentLease?: boolean;
};

async function queueOrderForSession(ctx: PlaneStorageCtx, sessionId: string): Promise<string> {
  const res = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessions,
      Key: { id: sessionId },
      ConsistentRead: true,
    }),
  );
  return queueOrderKeyForWrite(
    res.Item ? itemToSession(res.Item as Record<string, unknown>) : undefined,
    sessionId,
  );
}

export async function releaseMainCheckoutSession(
  ctx: PlaneStorageCtx,
  opts: ReleaseMainCheckoutOptions,
): Promise<boolean> {
  const isQueued = opts.status === "queued";
  const queueOrder = isQueued
    ? opts.queueOrder && opts.queueOrder.length > 0
      ? opts.queueOrder
      : await queueOrderForSession(ctx, opts.sessionId)
    : undefined;
  const before = isQueued ? null : await readSessionDrainActivity(ctx, opts.sessionId);
  const cleanup =
    isQueued || before?.session.cancelledByDrainOperationId
      ? []
      : sessionDrainActivityDelete(ctx, before?.activity ?? null);
  // A concurrent drain cancellation can become durable after the strong
  // pre-read above. Fence the release transaction itself so it cannot then
  // delete that drain's ACT member.
  const requireNoDrainCancellation = cleanup.length > 0;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression:
                (opts.hostAssignmentLease ? "SET assignmentCount = assignmentCount - :one " : "") +
                "REMOVE mainCheckoutLeases.#repo",
              ConditionExpression:
                "mainCheckoutLeases.#repo.sessionId = :sessionId AND mainCheckoutLeases.#repo.connectionId = :connectionId" +
                (opts.hostAssignmentLease ? " AND assignmentCount >= :one" : ""),
              ExpressionAttributeNames: { "#repo": opts.repositoryId },
              ExpressionAttributeValues: {
                ":sessionId": opts.sessionId,
                ":connectionId": opts.connectionId,
                ...(opts.hostAssignmentLease ? { ":one": 1 } : {}),
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
                (opts.requireUnacknowledged ? " AND attribute_not_exists(ackReceivedAt)" : "") +
                (requireNoDrainCancellation
                  ? " AND attribute_not_exists(cancelledByDrainOperationId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: expressionValues(opts, queueOrder),
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
          ...(opts.preserveProviderAccountLease
            ? []
            : providerAccountLeaseDeleteItems(
                ctx.tables.concurrencyLocks,
                opts.sessionId,
                opts.providerAccountLease,
              )),
          ...cleanup,
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalTransactionFailed(error)) {
      // Retry a cancellation release from the current durable state. The
      // retry observes the drain marker and omits ACT cleanup, while a stale
      // lease/status failure remains a normal false result.
      if (requireNoDrainCancellation && opts.expectedStatus === "cancelled") {
        const current = await readSessionDrainActivity(ctx, opts.sessionId);
        if (current?.session.cancelledByDrainOperationId) {
          return releaseMainCheckoutSession(ctx, opts);
        }
      }
      return false;
    }
    throw error;
  }
}

function updateExpression(opts: ReleaseMainCheckoutOptions, isQueued: boolean): string {
  return (
    "SET #s = :status, statusShard = :statusShard" +
    (isQueued ? ", queueOrder = :queueOrder" : "") +
    ", worktreeId = :null" +
    (isQueued ? ", hostId = :null" : "") +
    (opts.reason ? ", errorMessage = :reason" : "") +
    (opts.completedAt ? ", completedAt = :completedAt" : "") +
    (opts.exitCode !== undefined ? ", exitCode = :exitCode" : "") +
    (opts.errorCode ? ", errorCode = :errorCode" : "") +
    (opts.cliResumeRef ? ", cliResumeRef = :cliResumeRef" : "") +
    (opts.retryCount !== undefined ? ", retryCount = :retryCount" : "") +
    (opts.retryAfter ? ", retryAfter = :retryAfter" : "") +
    (opts.suppressedTargetIndex !== undefined
      ? ", suppressedTargetIndexes = list_append(if_not_exists(suppressedTargetIndexes, :empty), :index)"
      : "") +
    " REMOVE assignmentConnectionId, assignmentSentAt, reconnectDeadlineAt, mainCheckoutLease, ackReceivedAt" +
    (opts.preserveHostAssignmentLease ? "" : ", hostAssignmentLease") +
    (opts.preserveProviderAccountLease ? "" : ", providerAccountLease") +
    (isQueued ? ", startedAt" : "")
  );
}

function expressionValues(
  opts: ReleaseMainCheckoutOptions,
  queueOrder: string | undefined,
): Record<string, unknown> {
  return {
    ":status": opts.status,
    ":statusShard": statusShardAttr(opts.status, opts.queueShard),
    ...(opts.status === "queued" ? { ":queueOrder": queueOrder } : {}),
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
    ...(opts.suppressedTargetIndex !== undefined
      ? { ":empty": [], ":index": [opts.suppressedTargetIndex] }
      : {}),
    ...(opts.attemptId ? { ":attemptId": opts.attemptId } : {}),
  };
}
