/* eslint-disable max-lines */
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import { statusShardAttr } from "./dynamo.ts";
import type { SessionRecord, WorktreeRecord } from "./types.ts";
import {
  itemToSession,
  isConditionalFailed,
  isConditionalTransactionFailed,
  sessionToItem,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";

export async function putSession(ctx: PlaneStorageCtx, session: SessionRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessions,
      Item: sessionToItem(session),
    }),
  );
}

export async function getSession(ctx: PlaneStorageCtx, id: string): Promise<SessionRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.sessions, Key: { id } }));
  return res.Item ? itemToSession(res.Item) : null;
}

export async function listAllSessions(ctx: PlaneStorageCtx): Promise<SessionRecord[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.sessions,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items.map(itemToSession);
}

export async function listSessionsByStatus(
  ctx: PlaneStorageCtx,
  status: SessionStatus,
  shard: number,
): Promise<SessionRecord[]> {
  const res = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessions,
      IndexName: "statusShard-createdAt",
      KeyConditionExpression: "statusShard = :ss",
      ExpressionAttributeValues: {
        ":ss": statusShardAttr(status, shard),
      },
    }),
  );
  return (res.Items ?? []).map((i) => itemToSession(i as Record<string, unknown>));
}

export async function putWorktree(ctx: PlaneStorageCtx, wt: WorktreeRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.worktrees,
      Item: { ...wt },
    }),
  );
}

export async function getWorktree(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<WorktreeRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.worktrees, Key: { id } }));
  return (res.Item as WorktreeRecord | undefined) ?? null;
}

export async function listAllWorktrees(ctx: PlaneStorageCtx): Promise<WorktreeRecord[]> {
  const items: WorktreeRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.worktrees,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as WorktreeRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}

export async function listWorktreesForRepo(
  ctx: PlaneStorageCtx,
  repositoryId: string,
): Promise<WorktreeRecord[]> {
  const res = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.worktrees,
      IndexName: "repositoryId-id",
      KeyConditionExpression: "repositoryId = :r",
      ExpressionAttributeValues: { ":r": repositoryId },
    }),
  );
  return (res.Items ?? []) as WorktreeRecord[];
}

/** Conditional claim (Invariant 1): idle + online → busy. */
export async function tryClaimWorktree(
  ctx: PlaneStorageCtx,
  opts: { worktreeId: string; sessionId: string; now: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.worktrees,
        Key: { id: opts.worktreeId },
        UpdateExpression: "SET #s = :busy, currentSessionId = :sid, lastAssignedAt = :now",
        ConditionExpression: "#s = :idle AND #o = :true",
        ExpressionAttributeNames: { "#s": "status", "#o": "online" },
        ExpressionAttributeValues: {
          ":busy": "busy",
          ":idle": "idle",
          ":true": true,
          ":sid": opts.sessionId,
          ":now": opts.now,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) {
      return false;
    }
    throw err;
  }
}

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
    worktreeId: string;
    hostId: string;
    connectionId: string;
    now: string;
    resolvedArgv: string[];
    queueShard: number;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :busy, currentSessionId = :sid, lastAssignedAt = :now",
              ConditionExpression: "#s = :idle AND #o = :true",
              ExpressionAttributeNames: { "#s": "status", "#o": "online" },
              ExpressionAttributeValues: {
                ":busy": "busy",
                ":idle": "idle",
                ":true": true,
                ":sid": opts.sessionId,
                ":now": opts.now,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :running, statusShard = :statusShard, worktreeId = :wid, hostId = :hid, startedAt = :now, resolvedArgv = :argv REMOVE ackReceivedAt",
              ConditionExpression: "#s = :queued",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":running": "running",
                ":statusShard": statusShardAttr("running", opts.queueShard),
                ":queued": "queued",
                ":wid": opts.worktreeId,
                ":hid": opts.hostId,
                ":now": opts.now,
                ":argv": opts.resolvedArgv,
              },
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
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * A running session cancelled by an operator deliberately keeps its worktree
 * busy until the agent reports a terminal status. Release that exact claim
 * without changing the cancelled status, and detach the terminal session so a
 * duplicate late report is an idempotent no-op.
 */
export async function releaseCancelledSessionWorktree(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; worktreeId: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: "SET worktreeId = :null, hostId = :null",
              ConditionExpression: "#s = :cancelled AND worktreeId = :worktreeId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":cancelled": "cancelled",
                ":null": null,
                ":worktreeId": opts.worktreeId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null",
              ConditionExpression: "currentSessionId = :sid",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":idle": "idle",
                ":null": null,
                ":sid": opts.sessionId,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      const current = await getSession(ctx, opts.sessionId);
      return current?.status === "cancelled" && current.worktreeId == null;
    }
    throw err;
  }
}

/** Atomically release a worktree and requeue its running session. */
export async function tryRequeueSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    queueShard: number;
    reason?: string;
    forceOffline?: boolean;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
              ConditionExpression: "currentSessionId = :sid",
              ExpressionAttributeNames: { "#s": "status", "#o": "online" },
              ExpressionAttributeValues: {
                ":idle": "idle",
                ":null": null,
                ":online": opts.forceOffline !== true,
                ":sid": opts.sessionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, worktreeId = :null, hostId = :null, errorMessage = :reason REMOVE startedAt, ackReceivedAt",
              ConditionExpression: "#s = :running",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":running": "running",
                ":null": null,
                ":reason": opts.reason ?? "agent disconnected; requeued",
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}

/** Idempotent acknowledgement of an assigned running session. */
export async function acknowledgeSession(
  ctx: PlaneStorageCtx,
  sessionId: string,
  acknowledgedAt: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: sessionId },
        UpdateExpression: "SET ackReceivedAt = :at",
        ConditionExpression: "#s = :running AND attribute_not_exists(ackReceivedAt)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":at": acknowledgedAt, ":running": "running" },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) {
      // A duplicate ack is a successful no-op, while a late ack for a terminal
      // session is also harmless to the caller.
      const current = await getSession(ctx, sessionId);
      return current?.ackReceivedAt !== undefined || current?.status !== "running";
    }
    throw err;
  }
}

/** Atomically apply a terminal/retry transition and release its worktree. */
export async function finishSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId?: string | null;
    status: string;
    queueShard: number;
    completedAt?: string;
    errorCode?: string;
    errorMessage?: string;
    exitCode?: number | null;
    cliResumeRef?: string;
    retryCount?: number;
    retryAfter?: string;
  },
): Promise<boolean> {
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
    "hostId = :null",
  ];
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
  if (opts.retryCount !== undefined) {
    sets.push("retryCount = :retryCount");
    values[":retryCount"] = opts.retryCount;
  }
  if (opts.retryAfter !== undefined) {
    sets.push("retryAfter = :retryAfter");
    values[":retryAfter"] = opts.retryAfter;
  }
  const transactItems: Array<Record<string, unknown>> = [
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "#s = :running",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
  ];
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
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      const current = await getSession(ctx, opts.sessionId);
      return current?.status === opts.status;
    }
    throw err;
  }
}

export async function releaseWorktree(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  opts?: { forceOffline?: boolean },
): Promise<void> {
  const wt = await getWorktree(ctx, worktreeId);
  if (!wt) {
    return;
  }
  const online = opts?.forceOffline ? false : wt.online;
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
      ExpressionAttributeNames: { "#s": "status", "#o": "online" },
      ExpressionAttributeValues: {
        ":idle": "idle",
        ":null": null,
        ":online": online,
      },
    }),
  );
}

export async function setWorktreeOnline(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  online: boolean,
): Promise<void> {
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #o = :o",
      ExpressionAttributeNames: { "#o": "online" },
      ExpressionAttributeValues: { ":o": online },
    }),
  );
}
