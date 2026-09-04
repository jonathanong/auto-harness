import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import { sessionDrainCancellationUpdates } from "./plane-storage-session-drains.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
  sessionDrainActivityForScope,
} from "./plane-storage-session-drain-activity.ts";
import {
  drainCancelScope,
  drainCancelledByClause,
  writeCancelledSessionUpdate,
} from "./plane-storage-session-cancel-write.ts";

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
  const drain = drainCancelScope(opts);
  return writeCancelledSessionUpdate(
    ctx,
    {
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      UpdateExpression: `SET #s = :cancelled, statusShard = :statusShard, completedAt = :completedAt, errorMessage = :errorMessage${drainCancelledByClause(opts.drainOperationId)}`,
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
    },
    {
      sessionId: opts.sessionId,
      hostId: opts.hostId,
      attemptId: opts.attemptId,
      now: opts.completedAt,
    },
    drain,
  );
}

/**
 * Persist the transition from a native-resume attempt to a fresh queued run.
 * The observed host is conditional so an older scheduler cannot erase a pin
 * installed by a newer resume request. `prompt` carries the prior-context
 * pointer already appended in memory, so the durable row does not disagree
 * with the argv the very next placement pass resolves from it.
 */
export async function clearResumePin(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    pinnedHostId: string;
    pinExpiresAt?: string | undefined;
    prompt: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression:
          "SET resumeFallback = :true, #prompt = :prompt REMOVE pinnedHostId, pinnedProviderAccountId, pinnedTargetIndex, pinnedCommandId, pinExpiresAt, cliResumeRef",
        ConditionExpression:
          "#s = :queued AND pinnedHostId = :pinnedHostId" +
          (opts.pinExpiresAt === undefined ? "" : " AND pinExpiresAt = :pinExpiresAt"),
        ExpressionAttributeNames: { "#s": "status", "#prompt": "prompt" },
        ExpressionAttributeValues: {
          ":true": true,
          ":queued": "queued",
          ":pinnedHostId": opts.pinnedHostId,
          ":prompt": opts.prompt,
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
