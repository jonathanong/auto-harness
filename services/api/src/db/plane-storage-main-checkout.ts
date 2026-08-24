import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import type { SessionRecord } from "./types.ts";
import {
  assignmentLeaseCollision,
  isConditionalFailed,
  isConditionalTransactionFailed,
  type AssignmentWriteResult,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import { providerAccountLastAssignedTransactItem } from "./plane-storage-provider-account-assignment.ts";
import { sessionDrainAdmissionCheck } from "./plane-storage-session-drains.ts";
export {
  confirmMainCheckoutReconnect,
  markMainCheckoutReconnectPending,
} from "./plane-storage-main-checkout-reconnect.ts";
export { restoreMainCheckoutReconnect } from "./plane-storage-main-checkout-rollback.ts";
export { getMainCheckoutCursor, getMainCheckoutLease } from "./plane-storage-main-checkout-read.ts";
export { cancelRunningMainCheckoutSession } from "./plane-storage-main-checkout-cancel.ts";
export { releaseMainCheckoutSession } from "./plane-storage-main-checkout-release.ts";
export { requeueMainCheckoutUsageLimitedSession } from "./plane-storage-main-checkout-usage-limit.ts";

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
    hostInventoryVersion: number | null;
    principalId?: string;
    repositoryId: string;
    connectionId: string;
    now: string;
    resolvedArgv: string[];
    resumeSpec?: import("@auto-harness/shared").SessionResumeSpec;
    resolvedRoute: SessionRecord["resolvedRoute"];
    providerAccountId?: string;
    providerId?: string;
    providerAccountLease?: SessionRecord["providerAccountLease"];
    queueShard: number;
    attemptId: string;
  },
): Promise<AssignmentWriteResult> {
  const lease = { sessionId: opts.sessionId, connectionId: opts.connectionId };
  const drainCheck = sessionDrainAdmissionCheck(ctx, opts.repositoryId, opts.principalId);
  const transactItems = [
    {
      ConditionCheck: {
        TableName: ctx.tables.hostInventories,
        Key: { hostId: opts.hostId },
        ConditionExpression:
          opts.hostInventoryVersion === null
            ? "attribute_not_exists(hostId)"
            : "version = :inventoryVersion OR (attribute_not_exists(version) AND :inventoryVersion = :zero)",
        ...(opts.hostInventoryVersion === null
          ? {}
          : {
              ExpressionAttributeValues: {
                ":inventoryVersion": opts.hostInventoryVersion,
                ":zero": 0,
              },
            }),
      },
    },
    ...(drainCheck ? [drainCheck] : []),
    {
      ConditionCheck: {
        TableName: ctx.tables.repositories,
        Key: { id: opts.repositoryId },
        ConditionExpression:
          "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)",
        ExpressionAttributeValues: { ":active": "active" },
      },
    },
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
        UpdateExpression: "SET mainCheckoutLeases.#repo = :lease, lastScheduledAssignedAt = :now",
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
          (opts.providerAccountLease ? ", providerAccountLease = :providerAccountLease" : "") +
          " REMOVE ackReceivedAt, reconnectDeadlineAt, completedAt, exitCode, errorCode, errorMessage, retryAfter",
        ConditionExpression: "#s = :queued AND queueExpiresAt > :now",
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
          ...(opts.providerAccountLease
            ? { ":providerAccountLease": opts.providerAccountLease }
            : {}),
        },
      },
    },
    ...(opts.providerAccountId
      ? [
          providerAccountLastAssignedTransactItem(ctx, {
            providerAccountId: opts.providerAccountId,
            ...(opts.providerId ? { providerId: opts.providerId } : {}),
            now: opts.now,
            ...(opts.providerAccountLease ? { slot: opts.providerAccountLease.slot } : {}),
          }),
        ]
      : []),
    ...(opts.providerAccountLease
      ? [
          {
            Put: {
              TableName: ctx.tables.concurrencyLocks,
              Item: {
                concurrencyId: opts.providerAccountLease.concurrencyId,
                sessionId: opts.sessionId,
                attemptId: opts.attemptId,
                providerAccountId: opts.providerAccountLease.providerAccountId,
                slot: opts.providerAccountLease.slot,
                hostId: opts.hostId,
              },
              ConditionExpression: "attribute_not_exists(concurrencyId)",
            },
          },
        ]
      : []),
  ];
  const leaseIndex = opts.providerAccountLease ? transactItems.length - 1 : undefined;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
      }),
    );
    return true;
  } catch (err) {
    if (assignmentLeaseCollision(err, leaseIndex)) return "lease_collision";
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
