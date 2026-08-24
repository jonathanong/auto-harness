import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import {
  providerAccountLeaseDeleteItems,
  type ProviderAccountLeaseKey,
} from "./plane-storage-provider-account-leases.ts";

type FinishSessionOpts = {
  sessionId: string;
  worktreeId?: string | null;
  attemptId: string;
  status: string;
  queueShard: number;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  exitCode?: number | null;
  cliResumeRef?: string;
  fence?: { hostId: string; connectionId: string };
  concurrencyId?: string;
  providerAccountLease?: ProviderAccountLeaseKey | undefined;
};

function setOptional(
  sets: string[],
  values: Record<string, unknown>,
  attr: string,
  value: unknown,
): void {
  if (value === undefined) return;
  sets.push(`${attr} = :${attr}`);
  values[`:${attr}`] = value;
}

async function finishSessionCleanup(
  ctx: PlaneStorageCtx,
  opts: FinishSessionOpts,
): Promise<ReturnType<typeof sessionDrainActivityDelete>> {
  if (opts.status === "queued") return [];
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  if (before?.session.cancelledByDrainOperationId) return [];
  return sessionDrainActivityDelete(ctx, before?.activity ?? null);
}

function finishSessionUpdate(opts: FinishSessionOpts): {
  names: Record<string, string>;
  values: Record<string, unknown>;
  sets: string[];
  removes: string[];
} {
  const values: Record<string, unknown> = {
    ":status": opts.status,
    ":statusShard": statusShardAttr(opts.status, opts.queueShard),
    ":running": "running",
    ":null": null,
    ":worktreeId": opts.worktreeId ?? null,
    ":attemptId": opts.attemptId,
  };
  const sets = [
    "#s = :status",
    "statusShard = :statusShard",
    "worktreeId = :null",
    ...(opts.status === "queued" ? ["hostId = :null"] : []),
  ];
  setOptional(sets, values, "completedAt", opts.completedAt);
  setOptional(sets, values, "errorCode", opts.errorCode);
  setOptional(sets, values, "errorMessage", opts.errorMessage);
  setOptional(sets, values, "exitCode", opts.exitCode);
  setOptional(sets, values, "cliResumeRef", opts.cliResumeRef);
  return {
    names: { "#s": "status" },
    values,
    sets,
    removes: ["reconnectDeadlineAt", "assignmentConnectionId", "providerAccountLease"],
  };
}

function finishSessionItems(
  ctx: PlaneStorageCtx,
  opts: FinishSessionOpts,
  update: ReturnType<typeof finishSessionUpdate>,
  cleanup: ReturnType<typeof sessionDrainActivityDelete>,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [
    ...(opts.fence
      ? [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.fence.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.fence.connectionId },
            },
          },
        ]
      : []),
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: `SET ${update.sets.join(", ")} REMOVE ${update.removes.join(", ")}`,
        ConditionExpression:
          "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
        ExpressionAttributeNames: update.names,
        ExpressionAttributeValues: update.values,
      },
    },
  ];
  if (opts.worktreeId) {
    items.push({
      Update: {
        TableName: ctx.tables.worktrees,
        Key: { id: opts.worktreeId },
        UpdateExpression: "SET #s = :idle, currentSessionId = :null",
        ConditionExpression: "currentSessionId = :sid",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":idle": "idle", ":null": null, ":sid": opts.sessionId },
      },
    });
  }
  if (opts.concurrencyId && opts.status !== "queued") {
    items.push({
      Delete: {
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: opts.concurrencyId },
        ConditionExpression: "sessionId = :sessionId",
        ExpressionAttributeValues: { ":sessionId": opts.sessionId },
      },
    });
  }
  items.push(
    ...providerAccountLeaseDeleteItems(
      ctx.tables.concurrencyLocks,
      opts.sessionId,
      opts.providerAccountLease,
    ),
    ...cleanup,
  );
  return items;
}

async function finishSessionConflict(
  ctx: PlaneStorageCtx,
  err: unknown,
  opts: FinishSessionOpts,
  cleanup: ReturnType<typeof sessionDrainActivityDelete>,
): Promise<boolean> {
  if (!isConditionalTransactionFailed(err)) throw err;
  const current = await getSession(ctx, opts.sessionId);
  if (current?.status === opts.status && cleanup.length) {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: cleanup }));
  }
  return current?.status === opts.status;
}

/** Atomically apply a terminal transition and release its worktree. */
export async function finishSession(
  ctx: PlaneStorageCtx,
  opts: FinishSessionOpts,
): Promise<boolean> {
  const cleanup = await finishSessionCleanup(ctx, opts);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: finishSessionItems(ctx, opts, finishSessionUpdate(opts), cleanup),
      }),
    );
    return true;
  } catch (err) {
    return finishSessionConflict(ctx, err, opts, cleanup);
  }
}
