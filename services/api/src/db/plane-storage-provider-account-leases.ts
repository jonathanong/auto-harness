/* eslint-disable max-lines -- durable provider-account lease lifecycle and operator fencing share helpers. */
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { providerAccountLeaseConcurrencyId } from "@auto-harness/shared";
import { setTimeout as delay } from "node:timers/promises";

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
import { providerAccountCapCondition } from "./plane-storage-provider-account-cap.ts";
import type { SessionRecord } from "./types.ts";

export type ProviderAccountLeaseKey = {
  concurrencyId: string;
  attemptId: string;
  providerAccountId: string;
  slot: number;
};

export type ProviderAccountLeaseLock = ProviderAccountLeaseKey & {
  sessionId: string;
  hostId?: string;
};

type ProviderAccountLeaseBackfillResult =
  | { status: "migrated"; lease: ProviderAccountLeaseKey }
  | { status: "lease_collision" | "session_changed" };

/** Strongly read the durable slot holder before deciding whether it is safe to release. */
export async function getProviderAccountLeaseLock(
  ctx: PlaneStorageCtx,
  concurrencyId: string,
): Promise<ProviderAccountLeaseLock | null> {
  const response = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.concurrencyLocks,
      Key: { concurrencyId },
      ConsistentRead: true,
    }),
  );
  return (response.Item as ProviderAccountLeaseLock | undefined) ?? null;
}

async function batchGetAll(
  ctx: PlaneStorageCtx,
  requestItems: Record<string, { Keys: Record<string, unknown>[]; ConsistentRead: true }>,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let pending = requestItems;
  for (let attempts = 0; ; attempts += 1) {
    const response = await ctx.doc.send(new BatchGetCommand({ RequestItems: pending }));
    items.push(...Object.values(response.Responses ?? {}).flat());
    const unprocessed = response.UnprocessedKeys ?? {};
    if (Object.keys(unprocessed).length === 0) return items;
    if (attempts >= 7) throw new Error("DynamoDB BatchGetItem left unprocessed keys");
    await delay(Math.min(2 ** attempts, 50));
    pending = unprocessed as typeof pending;
  }
}

/** Strongly read the fixed synthetic slot keyspace in bounded BatchGetItem requests. */
export async function listProviderAccountLeaseLocks(
  ctx: PlaneStorageCtx,
  providerAccountId: string,
  maxSlots: number,
): Promise<ProviderAccountLeaseLock[]> {
  const locks = await batchGetAll(ctx, {
    [ctx.tables.concurrencyLocks]: {
      Keys: [...Array(maxSlots).keys()].map((slot) => ({
        concurrencyId: providerAccountLeaseConcurrencyId(providerAccountId, slot),
      })),
      ConsistentRead: true,
    },
  });
  return locks as ProviderAccountLeaseLock[];
}

/** Strongly read the holder sessions for a batch of lock rows, retrying unprocessed keys. */
export async function getProviderAccountLeaseHolderSessions(
  ctx: PlaneStorageCtx,
  leases: readonly ProviderAccountLeaseLock[],
): Promise<Map<string, SessionRecord>> {
  if (leases.length === 0) return new Map();
  const sessions = await batchGetAll(ctx, {
    [ctx.tables.sessions]: {
      Keys: [...new Set(leases.map((lease) => lease.sessionId))].map((id) => ({ id })),
      ConsistentRead: true,
    },
  });
  return new Map((sessions as SessionRecord[]).map((session) => [session.id, session]));
}

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
  // Mirrors providerAccountLastAssignedTransactItem's slot cap so a legacy backfill
  // cannot migrate a lease beyond the account's real concurrency limit, even if the
  // app-layer loop bound in control-plane-hydrate-provider-leases.ts races a
  // concurrent maxConcurrentSessions edit.
  const cap = providerAccountCapCondition(opts.slot);
  const providerAccountValues: Record<string, unknown> = { ...cap.values };
  let providerAccountCondition = `attribute_exists(id) AND (${cap.condition})`;
  if (opts.providerId !== undefined) {
    providerAccountCondition += " AND providerId = :providerId";
    providerAccountValues[":providerId"] = opts.providerId;
  }
  const transactItems = [
    {
      ConditionCheck: {
        TableName: ctx.tables.providerAccounts,
        Key: { id: opts.providerAccountId },
        ConditionExpression: providerAccountCondition,
        ExpressionAttributeValues: providerAccountValues,
      },
    },
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: "SET providerAccountLease = :lease",
        // A cancelled session only still occupies the account while release hasn't run yet —
        // release SETs worktreeId to NULL and REMOVEs mainCheckoutLease, so a live claim on
        // either is the fence against a release racing this transaction (see
        // control-plane-hydrate-provider-leases.ts for the matching app-layer filter).
        ConditionExpression:
          "( #s = :running OR (#s = :cancelled AND attribute_exists(hostId) AND ( (attribute_exists(worktreeId) AND NOT attribute_type(worktreeId, :nullType)) OR (attribute_exists(mainCheckoutLease) AND mainCheckoutLease = :true) )) ) AND attribute_not_exists(providerAccountLease) AND (attribute_not_exists(attemptId) OR attemptId = :attemptId) AND resolvedRoute.attemptId = :attemptId AND resolvedRoute.providerAccountId = :providerAccountId AND hostId = :hostId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":running": "running",
          ":cancelled": "cancelled",
          ":nullType": "NULL",
          ":true": true,
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

/**
 * Atomically remove a terminal session's exact provider-account lease and its
 * matching ConcurrencyLocks row. Every holder attribute is a transaction fence
 * so an operator can never free a lease reacquired by another attempt.
 */
export async function forceReleaseProviderAccountLease(
  ctx: PlaneStorageCtx,
  opts: {
    providerAccountId: string;
    slot: number;
    concurrencyId: string;
    sessionId: string;
    attemptId: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.providerAccounts,
              Key: { id: opts.providerAccountId },
              ConditionExpression: "attribute_exists(id)",
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: "REMOVE providerAccountLease",
              ConditionExpression:
                "#s IN (:completed, :failed, :cancelled, :timedOut) AND attemptId = :attemptId AND providerAccountLease.concurrencyId = :concurrencyId AND providerAccountLease.providerAccountId = :providerAccountId AND providerAccountLease.slot = :slot AND providerAccountLease.attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":completed": "completed",
                ":failed": "failed",
                ":cancelled": "cancelled",
                ":timedOut": "timed_out",
                ":attemptId": opts.attemptId,
                ":concurrencyId": opts.concurrencyId,
                ":providerAccountId": opts.providerAccountId,
                ":slot": opts.slot,
              },
            },
          },
          {
            Delete: {
              TableName: ctx.tables.concurrencyLocks,
              Key: { concurrencyId: opts.concurrencyId },
              ConditionExpression:
                "providerAccountId = :providerAccountId AND slot = :slot AND sessionId = :sessionId AND attemptId = :attemptId",
              ExpressionAttributeValues: {
                ":providerAccountId": opts.providerAccountId,
                ":slot": opts.slot,
                ":sessionId": opts.sessionId,
                ":attemptId": opts.attemptId,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
