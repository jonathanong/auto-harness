import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";

export type HostAssignmentLease = { hostId: string };

/** Increment the host's assignment count in the same transaction as the claim. */
export function hostAssignmentAcquireItem(
  ctx: PlaneStorageCtx,
  opts: { hostId: string; connectionId: string; cap: number; legacyAssignmentCount?: number },
) {
  const legacyAssignmentCount = opts.legacyAssignmentCount ?? 0;
  return {
    Update: {
      TableName: ctx.tables.hostLocks,
      Key: { hostId: opts.hostId },
      UpdateExpression: "SET assignmentCount = if_not_exists(assignmentCount, :legacyCount) + :one",
      ConditionExpression:
        "connectionId = :connectionId AND (attribute_not_exists(disconnected) OR disconnected = :false) AND (attribute_not_exists(draining) OR draining = :false) AND ((attribute_exists(assignmentCount) AND assignmentCount < :cap) OR (attribute_not_exists(assignmentCount) AND :legacyCount < :cap))",
      ExpressionAttributeValues: {
        ":connectionId": opts.connectionId,
        ":false": false,
        ":legacyCount": legacyAssignmentCount,
        ":one": 1,
        ":cap": opts.cap,
      },
    },
  };
}

/** Release a reservation owned by a completed/requeued assignment. */
export function hostAssignmentReleaseItem(ctx: PlaneStorageCtx, lease: HostAssignmentLease) {
  return {
    Update: {
      TableName: ctx.tables.hostLocks,
      Key: { hostId: lease.hostId },
      UpdateExpression: "SET assignmentCount = if_not_exists(assignmentCount, :one) - :one",
      ConditionExpression: "attribute_not_exists(assignmentCount) OR assignmentCount >= :one",
      ExpressionAttributeValues: { ":one": 1 },
    },
  };
}

/**
 * Reconcile capacity for a legacy providerless assignment that has no
 * persisted lease. This is deliberately separate from terminal writes: a
 * missing/zero legacy counter must not abort the session transition.
 */
export async function releaseLegacyHostAssignment(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; attemptId: string; hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: "SET legacyHostAssignmentReleased = :true",
              ConditionExpression:
                "(attemptId = :attemptId OR (attribute_not_exists(attemptId) AND resolvedRoute.attemptId = :attemptId)) AND #status <> :running AND attribute_not_exists(legacyHostAssignmentReleased)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":attemptId": opts.attemptId,
                ":running": "running",
                ":true": true,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression: "SET assignmentCount = assignmentCount - :one",
              ConditionExpression: "connectionId = :connectionId AND assignmentCount >= :one",
              ExpressionAttributeValues: {
                ":connectionId": opts.connectionId,
                ":one": 1,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error) || isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}

/** Release a timeout-preserved host slot when no provider-account lease exists. */
export async function releaseTimedOutHostAssignment(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    attemptId: string;
    hostId: string;
    hostAssignmentLease?: HostAssignmentLease | undefined;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "REMOVE timedOutHostId, timedOutAssignmentConnectionId, hostAssignmentLease",
              ConditionExpression:
                "#s = :timedOut AND timedOutHostId = :hostId AND attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":timedOut": "timed_out",
                ":hostId": opts.hostId,
                ":attemptId": opts.attemptId,
              },
            },
          },
          ...(opts.hostAssignmentLease
            ? [hostAssignmentReleaseItem(ctx, opts.hostAssignmentLease)]
            : []),
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error) || isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}
