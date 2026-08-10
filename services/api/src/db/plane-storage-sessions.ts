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

/** Registration inventory is written only while its exact host lease is
 * current. This prevents an old API process from publishing stale inventory
 * after a replacement connection has won the host lock. */
export async function putWorktreeFenced(
  ctx: PlaneStorageCtx,
  wt: WorktreeRecord,
  fence: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: fence.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": fence.connectionId },
            },
          },
          {
            Put: {
              TableName: ctx.tables.worktrees,
              Item: { ...wt },
              // A registration inventory snapshot must never overwrite an
              // assigned worktree. Reconciliation owns that transition.
              ConditionExpression: "attribute_not_exists(id) OR #s <> :busy",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":busy": "busy" },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
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
              UpdateExpression:
                "SET #s = :running, statusShard = :statusShard, worktreeId = :wid, hostId = :hid, startedAt = :now, resolvedArgv = :argv, assignmentConnectionId = :connectionId REMOVE ackReceivedAt, reconnectDeadlineAt",
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
                ":connectionId": opts.connectionId,
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
              ConditionExpression:
                "connectionId = :connectionId AND (attribute_not_exists(draining) OR draining = :false)",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId, ":false": false },
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
 * A resume pin is a deadline, not a scheduling preference. Guard the failure
 * transition with the observed pin value so a concurrent retry/resume cannot
 * be overwritten by a scheduler that hydrated an older queued row.
 */
export async function failExpiredResumeSession(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; queueShard: number; pinExpiresAt: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression:
          "SET #s = :failed, statusShard = :statusShard, errorCode = :errorCode, errorMessage = :errorMessage",
        ConditionExpression: "#s = :queued AND pinExpiresAt = :pinExpiresAt",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":statusShard": statusShardAttr("failed", opts.queueShard),
          ":errorCode": "resume_failed",
          ":errorMessage": "pin expired",
          ":queued": "queued",
          ":pinExpiresAt": opts.pinExpiresAt,
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
 * A running session cancelled by an operator deliberately keeps its worktree
 * busy until the agent reports a terminal status. Release that exact claim
 * without changing the cancelled status, and detach the terminal session so a
 * duplicate late report is an idempotent no-op.
 */
export async function releaseCancelledSessionWorktree(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    /** A late terminal report from a healthy socket frees the worktree for
     * another assignment; only disconnect cleanup offlines it. */
    online: boolean;
    fence?: { hostId: string; connectionId: string };
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
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
              UpdateExpression:
                "SET worktreeId = :null, hostId = :null REMOVE assignmentConnectionId, reconnectDeadlineAt",
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
              UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
              ConditionExpression:
                "currentSessionId = :sid" +
                (opts.fence
                  ? " AND (attribute_not_exists(connectionId) OR connectionId = :connectionId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status", "#o": "online" },
              ExpressionAttributeValues: {
                ":idle": "idle",
                ":null": null,
                ":sid": opts.sessionId,
                ":online": opts.online,
                ...(opts.fence ? { ":connectionId": opts.fence.connectionId } : {}),
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
    expectedHostId?: string;
    expectedReconnectDeadlineAt?: string;
    expectedConnectionId?: string;
    requireNoHostLock?: string;
    fence?: { hostId: string; connectionId: string };
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
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
          ...(opts.requireNoHostLock
            ? [
                {
                  ConditionCheck: {
                    TableName: ctx.tables.hostLocks,
                    Key: { hostId: opts.requireNoHostLock },
                    ConditionExpression: "attribute_not_exists(hostId)",
                  },
                },
              ]
            : []),
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
              ConditionExpression:
                "currentSessionId = :sid" +
                (opts.expectedConnectionId
                  ? " AND (attribute_not_exists(connectionId) OR connectionId = :connectionId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status", "#o": "online" },
              ExpressionAttributeValues: {
                ":idle": "idle",
                ":null": null,
                ":online": opts.forceOffline !== true,
                ":sid": opts.sessionId,
                ...(opts.expectedConnectionId
                  ? { ":connectionId": opts.expectedConnectionId }
                  : {}),
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, worktreeId = :null, hostId = :null, errorMessage = :reason REMOVE startedAt, ackReceivedAt, reconnectDeadlineAt, assignmentConnectionId",
              ConditionExpression:
                "#s = :running" +
                (opts.expectedHostId ? " AND hostId = :hostId" : "") +
                (opts.expectedReconnectDeadlineAt
                  ? " AND reconnectDeadlineAt = :reconnectDeadlineAt"
                  : "") +
                (opts.expectedConnectionId
                  ? " AND (attribute_not_exists(assignmentConnectionId) OR assignmentConnectionId = :connectionId)"
                  : ""),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":running": "running",
                ":null": null,
                ":reason": opts.reason ?? "agent disconnected; requeued",
                ...(opts.expectedHostId ? { ":hostId": opts.expectedHostId } : {}),
                ...(opts.expectedReconnectDeadlineAt
                  ? { ":reconnectDeadlineAt": opts.expectedReconnectDeadlineAt }
                  : {}),
                ...(opts.expectedConnectionId
                  ? { ":connectionId": opts.expectedConnectionId }
                  : {}),
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
  fence?: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    if (fence) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.tables.hostLocks,
                Key: { hostId: fence.hostId },
                ConditionExpression: "connectionId = :connectionId",
                ExpressionAttributeValues: { ":connectionId": fence.connectionId },
              },
            },
            {
              Update: {
                TableName: ctx.tables.sessions,
                Key: { id: sessionId },
                UpdateExpression: "SET ackReceivedAt = :at",
                ConditionExpression: "#s = :running AND attribute_not_exists(ackReceivedAt)",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":at": acknowledgedAt, ":running": "running" },
              },
            },
          ],
        }),
      );
      return true;
    }
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
    fence?: { hostId: string; connectionId: string };
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
  if (opts.retryCount !== undefined) {
    sets.push("retryCount = :retryCount");
    values[":retryCount"] = opts.retryCount;
  }
  if (opts.retryAfter !== undefined) {
    sets.push("retryAfter = :retryAfter");
    values[":retryAfter"] = opts.retryAfter;
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

export async function setWorktreeOnlineFenced(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  connectionId: string,
  online: boolean,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    if (fence) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.tables.hostLocks,
                Key: { hostId: fence.hostId },
                ConditionExpression: "connectionId = :connectionId",
                ExpressionAttributeValues: { ":connectionId": fence.connectionId },
              },
            },
            {
              Update: {
                TableName: ctx.tables.worktrees,
                Key: { id: worktreeId },
                UpdateExpression: "SET #o = :online",
                ConditionExpression:
                  "attribute_not_exists(connectionId) OR connectionId = :connectionId",
                ExpressionAttributeNames: { "#o": "online" },
                ExpressionAttributeValues: { ":online": online, ":connectionId": connectionId },
              },
            },
          ],
        }),
      );
    } else {
      await ctx.doc.send(
        new UpdateCommand({
          TableName: ctx.tables.worktrees,
          Key: { id: worktreeId },
          UpdateExpression: "SET #o = :online",
          ConditionExpression: "attribute_not_exists(connectionId) OR connectionId = :connectionId",
          ExpressionAttributeNames: { "#o": "online" },
          ExpressionAttributeValues: { ":online": online, ":connectionId": connectionId },
        }),
      );
    }
    return true;
  } catch (err) {
    if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
