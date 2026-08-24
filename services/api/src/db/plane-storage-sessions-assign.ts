import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import {
  assignmentLeaseCollision,
  isConditionalTransactionFailed,
  type AssignmentWriteResult,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import { providerAccountLastAssignedTransactItem } from "./plane-storage-provider-account-assignment.ts";
import { sessionDrainAdmissionCheck } from "./plane-storage-session-drains.ts";
import type { SessionRecord } from "./types.ts";

/**
 * Atomically claim a worktree and move its session to running.
 *
 * The old control-plane path updated the two rows independently and queued the
 * writes, which allowed two hydrated API processes to both emit an assignment.
 * Keeping the condition on both rows makes the operation safe to retry: one
 * caller wins and the other observes a conditional failure without changing
 * either row.
 */
export async function tryAssignSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    repositoryId: string;
    worktreeId: string;
    hostId: string;
    hostInventoryVersion: number | null;
    principalId?: string;
    connectionId: string;
    now: string;
    attemptId: string;
    resolvedArgv: string[];
    resumeSpec?: import("@auto-harness/shared").SessionResumeSpec;
    resolvedRoute: SessionRecord["resolvedRoute"];
    providerAccountId?: string;
    providerId?: string;
    providerAccountLease?: SessionRecord["providerAccountLease"];
    queueShard: number;
  },
): Promise<AssignmentWriteResult> {
  const sessionSets = [
    "#s = :running",
    "statusShard = :statusShard",
    "worktreeId = :wid",
    "hostId = :hid",
    "startedAt = :now",
    "attemptId = :attemptId",
    "resolvedArgv = :argv",
    "resolvedRoute = :route",
    "assignmentConnectionId = :connectionId",
  ];
  const sessionValues: Record<string, unknown> = {
    ":running": "running",
    ":statusShard": statusShardAttr("running", opts.queueShard),
    ":queued": "queued",
    ":wid": opts.worktreeId,
    ":hid": opts.hostId,
    ":now": opts.now,
    ":attemptId": opts.attemptId,
    ":argv": opts.resolvedArgv,
    ":connectionId": opts.connectionId,
    ":route": opts.resolvedRoute,
  };
  if (opts.resumeSpec !== undefined) {
    sessionSets.push("resumeSpec = if_not_exists(resumeSpec, :resumeSpec)");
    sessionValues[":resumeSpec"] = opts.resumeSpec;
  }
  if (opts.providerAccountLease) {
    sessionSets.push("providerAccountLease = :providerAccountLease");
    sessionValues[":providerAccountLease"] = opts.providerAccountLease;
  }
  const drainCheck = sessionDrainAdmissionCheck(ctx, opts.repositoryId, opts.principalId);
  const transactItems = [
    {
      ConditionCheck: {
        TableName: ctx.tables.repositories,
        Key: { id: opts.repositoryId },
        ConditionExpression:
          "attribute_exists(id) AND (attribute_not_exists(admissionState) OR admissionState = :active)",
        ExpressionAttributeValues: { ":active": "active" },
      },
    },
    ...(drainCheck ? [drainCheck] : []),
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
    {
      Update: {
        TableName: ctx.tables.worktrees,
        Key: { id: opts.worktreeId },
        UpdateExpression:
          "SET #s = :busy, currentSessionId = :sid, lastAssignedAt = :now, connectionId = :connectionId",
        ConditionExpression: "#s = :idle AND #o = :true",
        ExpressionAttributeNames: { "#s": "status", "#o": "online" },
        ExpressionAttributeValues: {
          ":busy": "busy",
          ":idle": "idle",
          ":true": true,
          ":sid": opts.sessionId,
          ":now": opts.now,
          ":connectionId": opts.connectionId,
        },
      },
    },
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: `SET ${sessionSets.join(", ")} REMOVE ackReceivedAt, reconnectDeadlineAt`,
        ConditionExpression: "#s = :queued AND queueExpiresAt > :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: sessionValues,
      },
    },
    {
      // A hydrated scheduler can retain an online worktree after a
      // different process disconnects its host. The lease is the
      // authority for reachability, so require the exact connection
      // that was live when this candidate was selected.
      ConditionCheck: {
        TableName: ctx.tables.hostLocks,
        Key: { hostId: opts.hostId },
        ConditionExpression:
          "connectionId = :connectionId AND (attribute_not_exists(disconnected) OR disconnected = :false) AND (attribute_not_exists(draining) OR draining = :false)",
        ExpressionAttributeValues: { ":connectionId": opts.connectionId, ":false": false },
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
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}
