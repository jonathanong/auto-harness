import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import type { SessionRecord } from "./types.ts";
import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
export {
  confirmMainCheckoutReconnect,
  markMainCheckoutReconnectPending,
} from "./plane-storage-main-checkout-reconnect.ts";
export { restoreMainCheckoutReconnect } from "./plane-storage-main-checkout-rollback.ts";
export { getMainCheckoutCursor, getMainCheckoutLease } from "./plane-storage-main-checkout-read.ts";
export { releaseMainCheckoutSession } from "./plane-storage-main-checkout-release.ts";

export async function ensureMainCheckoutLeaseMap(
  ctx: PlaneStorageCtx,
  hostId: string,
  connectionId: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.hostLocks,
        Key: { hostId },
        UpdateExpression: "SET mainCheckoutLeases = if_not_exists(mainCheckoutLeases, :empty)",
        ConditionExpression: "connectionId = :connectionId",
        ExpressionAttributeValues: { ":connectionId": connectionId, ":empty": {} },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) return false;
    throw err;
  }
}

export async function tryAssignMainCheckoutSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    now: string;
    resolvedArgv: string[];
    resumeSpec?: import("@auto-harness/shared").SessionResumeSpec;
    resolvedRoute: SessionRecord["resolvedRoute"];
    providerAccountId?: string;
    queueShard: number;
    attemptId: string;
  },
): Promise<boolean> {
  const lease = { sessionId: opts.sessionId, connectionId: opts.connectionId };
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.connections,
              Key: { connectionId: opts.connectionId },
              ConditionExpression:
                "hostId = :hostId AND contains(capabilities, :capability) AND contains(repositoryIds, :repositoryId)",
              ExpressionAttributeValues: {
                ":hostId": opts.hostId,
                ":capability": "scheduled-main-checkout",
                ":repositoryId": opts.repositoryId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression:
                "SET mainCheckoutLeases.#repo = :lease, lastScheduledAssignedAt = :now",
              ConditionExpression:
                "connectionId = :connectionId AND (attribute_not_exists(draining) OR draining = :false) AND attribute_not_exists(mainCheckoutLeases.#repo)",
              ExpressionAttributeNames: { "#repo": opts.repositoryId },
              ExpressionAttributeValues: {
                ":connectionId": opts.connectionId,
                ":false": false,
                ":lease": lease,
                ":now": opts.now,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :running, statusShard = :statusShard, worktreeId = :null, hostId = :hostId, startedAt = :now, assignmentSentAt = :now, resolvedArgv = :argv, resolvedRoute = :route, assignmentConnectionId = :connectionId, mainCheckoutLease = :true, attemptId = :attemptId" +
                (opts.resumeSpec ? ", resumeSpec = if_not_exists(resumeSpec, :resumeSpec)" : "") +
                " REMOVE ackReceivedAt, reconnectDeadlineAt, completedAt, exitCode, errorCode, errorMessage, retryAfter",
              ConditionExpression: "#s = :queued",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":running": "running",
                ":statusShard": statusShardAttr("running", opts.queueShard),
                ":queued": "queued",
                ":null": null,
                ":hostId": opts.hostId,
                ":now": opts.now,
                ":argv": opts.resolvedArgv,
                ":route": opts.resolvedRoute,
                ":connectionId": opts.connectionId,
                ":true": true,
                ":attemptId": opts.attemptId,
                ...(opts.resumeSpec ? { ":resumeSpec": opts.resumeSpec } : {}),
              },
            },
          },
          ...(opts.providerAccountId
            ? [
                {
                  Update: {
                    TableName: ctx.tables.providerAccounts,
                    Key: { id: opts.providerAccountId },
                    UpdateExpression: "SET lastAssignedAt = :now, updatedAt = :now",
                    ConditionExpression:
                      "attribute_exists(id) AND (attribute_not_exists(usageLimitedUntil) OR usageLimitedUntil <= :now)",
                    ExpressionAttributeValues: { ":now": opts.now },
                  },
                },
              ]
            : []),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
