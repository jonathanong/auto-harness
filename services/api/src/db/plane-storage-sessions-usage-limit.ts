import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { queueOrderForSession } from "./plane-storage-sessions-queue.ts";
import {
  providerAccountLeaseDeleteItems,
  type ProviderAccountLeaseKey,
} from "./plane-storage-provider-account-leases.ts";

function idleClaimedWorktreeUpdate(
  ctx: PlaneStorageCtx,
  opts: { worktreeId: string; sessionId: string },
) {
  return {
    Update: {
      TableName: ctx.tables.worktrees,
      Key: { id: opts.worktreeId },
      UpdateExpression: "SET #s = :idle, currentSessionId = :null",
      ConditionExpression: "currentSessionId = :sid",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":idle": "idle", ":null": null, ":sid": opts.sessionId },
    },
  };
}

function usageLimitRequeueSessionUpdate(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    queueShard: number;
    queueOrder: unknown;
    errorMessage: string;
    extraSet?: string;
    extraValues?: Record<string, unknown>;
  },
) {
  return {
    Update: {
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      UpdateExpression:
        "SET #s = :queued, statusShard = :statusShard, queueOrder = :queueOrder" +
        ", worktreeId = :null, hostId = :null, errorCode = :code, errorMessage = :message" +
        (opts.extraSet ?? "") +
        " REMOVE startedAt, ackReceivedAt, providerAccountLease",
      ConditionExpression: "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":queued": "queued",
        ":running": "running",
        ":statusShard": statusShardAttr("queued", opts.queueShard),
        ":queueOrder": opts.queueOrder,
        ":null": null,
        ":code": "usage_limit",
        ":message": opts.errorMessage,
        ":worktreeId": opts.worktreeId,
        ":attemptId": opts.attemptId,
        ...opts.extraValues,
      },
    },
  };
}

async function commitUsageLimitRequeue(
  ctx: PlaneStorageCtx,
  items: Array<Record<string, unknown>>,
): Promise<boolean> {
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

/** Atomically pause the assigned global account, free the worktree, and requeue the session. */
export async function requeueUsageLimitedSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    providerAccountId: string;
    queueShard: number;
    now: string;
    usageLimitedUntil: string;
    errorMessage?: string;
    providerAccountLease?: ProviderAccountLeaseKey;
  },
): Promise<boolean> {
  const queueOrder = await queueOrderForSession(ctx, opts.sessionId);
  return commitUsageLimitRequeue(ctx, [
    {
      Update: {
        TableName: ctx.tables.providerAccounts,
        Key: { id: opts.providerAccountId },
        UpdateExpression:
          "SET usageLimitedUntil = :until, lastUsageLimitedAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeValues: { ":until": opts.usageLimitedUntil, ":now": opts.now },
      },
    },
    idleClaimedWorktreeUpdate(ctx, opts),
    usageLimitRequeueSessionUpdate(ctx, {
      sessionId: opts.sessionId,
      worktreeId: opts.worktreeId,
      attemptId: opts.attemptId,
      queueShard: opts.queueShard,
      queueOrder,
      errorMessage: opts.errorMessage ?? "provider usage limit; requeued",
    }),
    ...providerAccountLeaseDeleteItems(
      ctx.tables.concurrencyLocks,
      opts.sessionId,
      opts.providerAccountLease,
    ),
  ]);
}

/** Requeue a providerless command and remember that this target is exhausted for this session. */
export async function suppressProviderlessUsageLimit(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    queueShard: number;
    targetIndex: number;
    errorMessage?: string;
    providerAccountLease?: ProviderAccountLeaseKey;
  },
): Promise<boolean> {
  const queueOrder = await queueOrderForSession(ctx, opts.sessionId);
  return commitUsageLimitRequeue(ctx, [
    idleClaimedWorktreeUpdate(ctx, opts),
    usageLimitRequeueSessionUpdate(ctx, {
      sessionId: opts.sessionId,
      worktreeId: opts.worktreeId,
      attemptId: opts.attemptId,
      queueShard: opts.queueShard,
      queueOrder,
      errorMessage: opts.errorMessage ?? "providerless usage limit; trying fallback",
      extraSet:
        ", suppressedTargetIndexes = list_append(if_not_exists(suppressedTargetIndexes, :empty), :index)",
      extraValues: { ":empty": [], ":index": [opts.targetIndex] },
    }),
    ...providerAccountLeaseDeleteItems(
      ctx.tables.concurrencyLocks,
      opts.sessionId,
      opts.providerAccountLease,
    ),
  ]);
}
