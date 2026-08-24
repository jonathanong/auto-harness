import { DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { providerAccountLeaseConcurrencyId } from "@auto-harness/shared";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  isConditionalTransactionFailureAt,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import {
  hostAssignmentReleaseItem,
  type HostAssignmentLease,
} from "./plane-storage-host-assignment.ts";

export type ProviderAccountLeaseKey = {
  concurrencyId: string;
  attemptId: string;
  providerAccountId: string;
  slot: number;
};

type ProviderAccountLeaseBackfillResult =
  | { status: "migrated"; lease: ProviderAccountLeaseKey }
  | { status: "lease_collision" | "session_changed" };

/**
 * Migrate one active legacy assignment to an attempt-owned provider lease.
 * The session update and lock reservation are one transaction: a stale
 * hydrator cannot reserve a slot after the assignment changed, and two API
 * processes cannot backfill the same slot.
 */
export async function backfillProviderAccountLease(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    attemptId: string;
    hostId: string;
    providerAccountId: string;
    providerId?: string;
    slot: number;
  },
): Promise<ProviderAccountLeaseBackfillResult> {
  const lease = {
    concurrencyId: providerAccountLeaseConcurrencyId(opts.providerAccountId, opts.slot),
    providerAccountId: opts.providerAccountId,
    slot: opts.slot,
    attemptId: opts.attemptId,
  };
  const providerAccountValues: Record<string, unknown> = { ":providerId": opts.providerId };
  const providerAccountCondition = opts.providerId
    ? "attribute_exists(id) AND providerId = :providerId"
    : "attribute_exists(id)";
  const transactItems = [
    {
      ConditionCheck: {
        TableName: ctx.tables.providerAccounts,
        Key: { id: opts.providerAccountId },
        ConditionExpression: providerAccountCondition,
        ...(opts.providerId ? { ExpressionAttributeValues: providerAccountValues } : {}),
      },
    },
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: "SET providerAccountLease = :lease",
        ConditionExpression:
          "( #s = :running OR (#s = :cancelled AND attribute_exists(hostId)) ) AND attribute_not_exists(providerAccountLease) AND (attribute_not_exists(attemptId) OR attemptId = :attemptId) AND resolvedRoute.attemptId = :attemptId AND resolvedRoute.providerAccountId = :providerAccountId AND hostId = :hostId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":running": "running",
          ":cancelled": "cancelled",
          ":lease": lease,
          ":attemptId": opts.attemptId,
          ":providerAccountId": opts.providerAccountId,
          ":hostId": opts.hostId,
        },
      },
    },
    {
      Put: {
        TableName: ctx.tables.concurrencyLocks,
        Item: {
          ...lease,
          sessionId: opts.sessionId,
          hostId: opts.hostId,
        },
        ConditionExpression: "attribute_not_exists(concurrencyId)",
      },
    },
  ];
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
    return { status: "migrated", lease };
  } catch (err) {
    if (!isConditionalFailed(err) && !isConditionalTransactionFailed(err)) {
      throw err;
    }
    // A sole lock failure means another hydrator owns this slot. Any other
    // conditional failure fenced this session or its catalog account.
    if (
      isConditionalTransactionFailureAt(err, 2) &&
      !isConditionalTransactionFailureAt(err, 0) &&
      !isConditionalTransactionFailureAt(err, 1)
    ) {
      return { status: "lease_collision" };
    }
    return { status: "session_changed" };
  }
}

/** Attempt-owned lock delete; missing rows succeed so a retry cannot stick the slot. */
function providerAccountLeaseDeleteItem(
  tableName: string,
  opts: { concurrencyId: string; sessionId: string; attemptId: string },
) {
  return {
    Delete: {
      TableName: tableName,
      Key: { concurrencyId: opts.concurrencyId },
      ConditionExpression:
        "attribute_not_exists(concurrencyId) OR (sessionId = :sessionId AND attemptId = :attemptId)",
      ExpressionAttributeValues: {
        ":sessionId": opts.sessionId,
        ":attemptId": opts.attemptId,
      },
    },
  };
}

export function providerAccountLeaseDeleteItems(
  tableName: string,
  sessionId: string,
  lease: ProviderAccountLeaseKey | undefined,
) {
  return lease
    ? [
        providerAccountLeaseDeleteItem(tableName, {
          concurrencyId: lease.concurrencyId,
          sessionId,
          attemptId: lease.attemptId,
        }),
      ]
    : [];
}

/** Delete only the lease owned by this attempt; a later slot owner is untouched. */
export async function releaseProviderAccountLease(
  ctx: PlaneStorageCtx,
  opts: { concurrencyId: string; sessionId: string; attemptId: string },
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: opts.concurrencyId },
        ConditionExpression:
          "attribute_not_exists(concurrencyId) OR (sessionId = :sessionId AND attemptId = :attemptId)",
        ExpressionAttributeValues: {
          ":sessionId": opts.sessionId,
          ":attemptId": opts.attemptId,
        },
      }),
    );
  } catch (err) {
    if (!isConditionalFailed(err)) throw err;
  }
}

/** Atomically remove a timeout-preserved lease from its session and lock. */
export async function releaseTimedOutProviderAccountLease(
  ctx: PlaneStorageCtx,
  opts: {
    concurrencyId: string;
    sessionId: string;
    attemptId: string;
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
                "REMOVE providerAccountLease, timedOutHostId, timedOutAssignmentConnectionId, hostAssignmentLease",
              ConditionExpression:
                "#s = :timedOut AND providerAccountLease.concurrencyId = :concurrencyId AND providerAccountLease.attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":timedOut": "timed_out",
                ":concurrencyId": opts.concurrencyId,
                ":attemptId": opts.attemptId,
              },
            },
          },
          providerAccountLeaseDeleteItem(ctx.tables.concurrencyLocks, opts),
          ...(opts.hostAssignmentLease
            ? [hostAssignmentReleaseItem(ctx, opts.hostAssignmentLease)]
            : []),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
