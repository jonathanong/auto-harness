/* eslint-disable max-lines -- terminal transition fencing and cleanup form one atomic storage operation. */
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionResult } from "@auto-harness/shared";

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
import {
  hostAssignmentReleaseItem,
  type HostAssignmentLease,
} from "./plane-storage-host-assignment.ts";

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
  result?: SessionResult;
  fence?: { hostId: string; connectionId: string };
  expectedReconnectDeadlineAt?: string;
  expectedConnectionId?: string;
  concurrencyId?: string;
  providerAccountLease?: ProviderAccountLeaseKey | undefined;
  hostAssignmentLease?: HostAssignmentLease | undefined;
  /** Timeout keeps the slot until the daemon reports terminal or disconnect recovery. */
  preserveProviderAccountLease?: boolean;
  /** Timeout keeps host capacity until terminal/disconnect cleanup. */
  preserveHostAssignmentLease?: boolean;
  timedOutHostId?: string;
  timedOutAssignmentConnectionId?: string;
  /** Retain a host-indexed, replacement-daemon terminal-hook handoff. */
  terminalHookHandoff?: import("./types.ts").SessionRecord["terminalHookHandoff"];
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
    ...(opts.expectedReconnectDeadlineAt
      ? { ":reconnectDeadlineAt": opts.expectedReconnectDeadlineAt }
      : {}),
    ...(opts.expectedConnectionId ? { ":connectionId": opts.expectedConnectionId } : {}),
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
  if (opts.result !== undefined) {
    sets.push("#result = if_not_exists(#result, :result)");
    values[":result"] = opts.result;
  }
  setOptional(sets, values, "timedOutHostId", opts.timedOutHostId);
  setOptional(sets, values, "timedOutAssignmentConnectionId", opts.timedOutAssignmentConnectionId);
  if (opts.terminalHookHandoff !== undefined) {
    sets.push("terminalHookHandoff = :terminalHookHandoff");
    values[":terminalHookHandoff"] = opts.terminalHookHandoff;
  }
  return {
    names: {
      "#s": "status",
      ...(opts.result !== undefined ? { "#result": "result" } : {}),
    },
    values,
    sets,
    removes: [
      ...(opts.terminalHookHandoff ? ["terminalHookHandoffSettled"] : []),
      "reconnectDeadlineAt",
      "assignmentConnectionId",
      ...(opts.preserveHostAssignmentLease || opts.terminalHookHandoff
        ? []
        : ["activeHostId", "activeHostOrder"]),
      ...(opts.preserveHostAssignmentLease ? [] : ["hostAssignmentLease"]),
      ...(opts.preserveProviderAccountLease ? [] : ["providerAccountLease"]),
    ],
  };
}

function finishSessionCondition(opts: FinishSessionOpts): string {
  return `#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId${opts.expectedReconnectDeadlineAt ? " AND reconnectDeadlineAt = :reconnectDeadlineAt" : ""}${opts.expectedConnectionId ? " AND (attribute_not_exists(assignmentConnectionId) OR assignmentConnectionId = :connectionId)" : ""}`;
}

function finishSessionItems(
  ctx: PlaneStorageCtx,
  opts: FinishSessionOpts,
  update: ReturnType<typeof finishSessionUpdate>,
  cleanup: ReturnType<typeof sessionDrainActivityDelete>,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [
    ...(!opts.hostAssignmentLease && opts.fence
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
        ConditionExpression: finishSessionCondition(opts),
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
    ...(opts.preserveProviderAccountLease
      ? []
      : providerAccountLeaseDeleteItems(
          ctx.tables.concurrencyLocks,
          opts.sessionId,
          opts.providerAccountLease,
        )),
    ...(opts.hostAssignmentLease ? [hostAssignmentReleaseItem(ctx, opts.hostAssignmentLease)] : []),
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

/**
 * The hook itself is an agent-local side effect. Its completion only clears
 * the durable handoff when the current host connection confirms the exact
 * handoff id, so a replacement socket cannot settle a stale delivery.
 */
export async function settleTerminalHookHandoff(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    handoffId: string;
    hostId: string;
    connectionId: string;
    result?: import("@auto-harness/shared").SessionResult;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: `SET terminalHookHandoffSettled = :settled${opts.result ? ", #result = :result" : ""} REMOVE terminalHookHandoff, activeHostId, activeHostOrder`,
              ConditionExpression:
                "terminalHookHandoff.handoffId = :handoffId AND terminalHookHandoff.hostId = :hostId",
              ExpressionAttributeNames: opts.result ? { "#result": "result" } : undefined,
              ExpressionAttributeValues: {
                ":handoffId": opts.handoffId,
                ":hostId": opts.hostId,
                ":settled": { handoffId: opts.handoffId, hostId: opts.hostId },
                ...(opts.result ? { ":result": opts.result } : {}),
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (!isConditionalTransactionFailed(err)) throw err;
    const current = await getSession(ctx, opts.sessionId, true);
    return (
      current?.terminalHookHandoffSettled?.handoffId === opts.handoffId &&
      current.terminalHookHandoffSettled.hostId === opts.hostId
    );
  }
}

/** Expire an unreachable replacement-daemon handoff without leaving its host index forever. */
export async function expireTerminalHookHandoff(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; handoffId: string; expiresAt: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression:
          "SET terminalHookHandoffExpiredAt = :expiredAt REMOVE terminalHookHandoff, activeHostId, activeHostOrder",
        ConditionExpression:
          "terminalHookHandoff.handoffId = :handoffId AND terminalHookHandoff.expiresAt = :expiresAt",
        ExpressionAttributeValues: {
          ":handoffId": opts.handoffId,
          ":expiresAt": opts.expiresAt,
          ":expiredAt": opts.expiresAt,
        },
      }),
    );
    return true;
  } catch (err) {
    if (!isConditionalTransactionFailed(err)) throw err;
    return false;
  }
}
