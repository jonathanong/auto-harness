import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";
import { getSession } from "./plane-storage-sessions-query.ts";

/** Atomically apply a terminal transition and release its worktree. */
export async function finishSession(
  ctx: PlaneStorageCtx,
  opts: {
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
  },
): Promise<boolean> {
  const before =
    opts.status === "queued" ? null : await readSessionDrainActivity(ctx, opts.sessionId);
  const cleanup =
    opts.status === "queued" || before?.session.cancelledByDrainOperationId
      ? []
      : sessionDrainActivityDelete(ctx, before?.activity ?? null);
  const values: Record<string, unknown> = {
    ":status": opts.status,
    ":statusShard": statusShardAttr(opts.status, opts.queueShard),
    ":running": "running",
    ":null": null,
  };
  const names: Record<string, string> = { "#s": "status" };
  const sets = [
    "#s = :status",
    "statusShard = :statusShard",
    "worktreeId = :null",
    ...(opts.status === "queued" ? ["hostId = :null"] : []),
  ];
  const removes = ["reconnectDeadlineAt", "assignmentConnectionId"];
  if (opts.completedAt !== undefined) {
    sets.push("completedAt = :completedAt");
    values[":completedAt"] = opts.completedAt;
  }
  if (opts.errorCode !== undefined) {
    sets.push("errorCode = :errorCode");
    values[":errorCode"] = opts.errorCode;
  }
  if (opts.errorMessage !== undefined) {
    sets.push("errorMessage = :errorMessage");
    values[":errorMessage"] = opts.errorMessage;
  }
  if (opts.exitCode !== undefined) {
    sets.push("exitCode = :exitCode");
    values[":exitCode"] = opts.exitCode;
  }
  if (opts.cliResumeRef !== undefined) {
    sets.push("cliResumeRef = :cliResumeRef");
    values[":cliResumeRef"] = opts.cliResumeRef;
  }
  const transactItems: Array<Record<string, unknown>> = [
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
        UpdateExpression: `SET ${sets.join(", ")} REMOVE ${removes.join(", ")}`,
        ConditionExpression:
          "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
  ];
  values[":worktreeId"] = opts.worktreeId ?? null;
  values[":attemptId"] = opts.attemptId;
  if (opts.worktreeId) {
    transactItems.push({
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
    transactItems.push({
      Delete: {
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: opts.concurrencyId },
        ConditionExpression: "sessionId = :sessionId",
        ExpressionAttributeValues: { ":sessionId": opts.sessionId },
      },
    });
  }
  transactItems.push(...cleanup);
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      const current = await getSession(ctx, opts.sessionId);
      if (current?.status === opts.status && cleanup.length) {
        await ctx.doc.send(new TransactWriteCommand({ TransactItems: cleanup }));
      }
      return current?.status === opts.status;
    }
    throw err;
  }
}

/** Conditionally expire a queued session without requiring a worktree lease. */
export async function expireQueuedSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    queueShard: number;
    queueExpiresAt: string;
    completedAt: string;
    concurrencyId?: string;
  },
): Promise<boolean> {
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :failed, statusShard = :statusShard, completedAt = :completedAt, errorCode = :code, errorMessage = :message",
              ConditionExpression: "#s = :queued AND queueExpiresAt = :expiresAt",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":failed": "failed",
                ":statusShard": statusShardAttr("failed", opts.queueShard),
                ":completedAt": opts.completedAt,
                ":expiresAt": opts.queueExpiresAt,
                ":code": "queue_expired",
                ":message": "queue TTL expired before capacity became available",
              },
            },
          },
          ...(opts.concurrencyId
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
          ...sessionDrainActivityDelete(ctx, before?.activity ?? null),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
