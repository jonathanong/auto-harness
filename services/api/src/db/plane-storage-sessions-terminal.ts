/* eslint-disable max-lines -- terminal release fencing spans sessions, workspaces, and handoffs. */
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionResult } from "@auto-harness/shared";

import { statusShardAttr } from "./dynamo.ts";
import {
  isConditionalTransactionFailed,
  type ArchiveMetadata,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
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
  workspaceSlotId?: string | null;
  workspaceSlotError?: string;
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
  /** Timeout keeps a workspace slot until terminal/disconnect cleanup. */
  preserveWorkspaceSlotLease?: boolean;
  /** A disconnected timeout keeps its reconnect marker until grace expiry. */
  preserveReconnectDeadlineAt?: boolean;
  /** Bounded safe-replay marker for a pre-launch host loss. */
  infrastructureErrorCode?: "checkout_fetch_failed" | "host_lost";
  timedOutHostId?: string;
  timedOutAssignmentConnectionId?: string;
  /** Retain a host-indexed, replacement-daemon terminal-hook handoff. */
  terminalHookHandoff?: import("./types.ts").SessionRecord["terminalHookHandoff"];
  expectedTerminalHookHandoffAbsent?: boolean;
  expectedStatus?: string;
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
    ":expectedStatus": opts.expectedStatus ?? "running",
    ":null": null,
    ":worktreeId": opts.worktreeId ?? null,
    ":attemptId": opts.attemptId,
    ...(opts.expectedReconnectDeadlineAt
      ? { ":reconnectDeadlineAt": opts.expectedReconnectDeadlineAt }
      : {}),
    ...(opts.expectedConnectionId ? { ":connectionId": opts.expectedConnectionId } : {}),
    ...(opts.workspaceSlotId !== undefined ? { ":workspaceSlotId": opts.workspaceSlotId } : {}),
    ...(opts.infrastructureErrorCode
      ? {
          ":zero": 0,
          ":one": 1,
          ":maxInfrastructureRetries": 1,
          ":infrastructureErrorCode": opts.infrastructureErrorCode,
          ":pendingCommandStart": "pending",
        }
      : {}),
  };
  const sets = [
    "#s = :status",
    "statusShard = :statusShard",
    "worktreeId = :null",
    ...(opts.preserveWorkspaceSlotLease ? [] : ["workspaceSlotId = :null"]),
    ...(opts.status === "queued" ? ["hostId = :null"] : []),
    ...(opts.infrastructureErrorCode
      ? [
          "infrastructureRetryCount = if_not_exists(infrastructureRetryCount, :zero) + :one",
          "lastInfrastructureErrorCode = :infrastructureErrorCode",
          "infrastructureRetryAttemptId = :attemptId",
        ]
      : []),
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
      ...(opts.preserveReconnectDeadlineAt ? [] : ["reconnectDeadlineAt"]),
      "assignmentConnectionId",
      ...(opts.preserveHostAssignmentLease || opts.terminalHookHandoff
        ? []
        : ["activeHostId", "activeHostOrder"]),
      ...(opts.preserveHostAssignmentLease ? [] : ["hostAssignmentLease"]),
      ...(opts.preserveProviderAccountLease ? [] : ["providerAccountLease"]),
      ...(opts.preserveWorkspaceSlotLease ? [] : ["workspaceSlotLease"]),
      ...(opts.infrastructureErrorCode ? ["primaryCommandStartState"] : []),
      "sessionApiKeyHash",
    ],
  };
}

function finishSessionCondition(opts: FinishSessionOpts): string {
  return `#s = :expectedStatus AND worktreeId = :worktreeId${opts.workspaceSlotId !== undefined ? " AND workspaceSlotId = :workspaceSlotId" : ""} AND attemptId = :attemptId${opts.expectedTerminalHookHandoffAbsent ? " AND attribute_not_exists(terminalHookHandoff)" : ""}${opts.expectedReconnectDeadlineAt ? " AND reconnectDeadlineAt = :reconnectDeadlineAt" : ""}${opts.expectedConnectionId ? " AND (attribute_not_exists(assignmentConnectionId) OR assignmentConnectionId = :connectionId)" : ""}${opts.infrastructureErrorCode ? " AND (attribute_not_exists(infrastructureRetryCount) OR infrastructureRetryCount < :maxInfrastructureRetries) AND primaryCommandStartState = :pendingCommandStart" : ""}`;
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
        ExpressionAttributeValues: {
          ...update.values,
        },
      },
    },
  ];
  // A terminal hook still needs the failed checkout's files. Keep its
  // worktree assignment fenced until the handoff settles or expires so a
  // concurrent scheduler cannot reset those files with a new checkout first.
  if (opts.worktreeId && opts.terminalHookHandoff?.worktreeId !== opts.worktreeId) {
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
  if (opts.workspaceSlotId && !opts.preserveWorkspaceSlotLease) {
    const failed = opts.workspaceSlotError !== undefined;
    items.push({
      Update: {
        TableName: ctx.tables.workspaceSlots,
        Key: { id: opts.workspaceSlotId },
        UpdateExpression: failed
          ? "SET #s = :status, currentSessionId = :null, errorMessage = :errorMessage"
          : "SET #s = :status, currentSessionId = :null REMOVE errorMessage",
        ConditionExpression: "currentSessionId = :sessionId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": failed ? "error" : "idle",
          ":null": null,
          ":sessionId": opts.sessionId,
          ...(failed ? { ":errorMessage": opts.workspaceSlotError } : {}),
        },
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

function reservedWorktreeReleaseItem(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  sessionId: string,
  connectionId?: string,
): Record<string, unknown> {
  const hasCurrentConnection = connectionId !== undefined;
  return {
    Update: {
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: `SET #s = :idle, currentSessionId = :null${hasCurrentConnection ? ", #o = :online, connectionId = :connectionId" : ""}`,
      ConditionExpression: "currentSessionId = :sid",
      ExpressionAttributeNames: {
        "#s": "status",
        ...(hasCurrentConnection ? { "#o": "online" } : {}),
      },
      ExpressionAttributeValues: {
        ":idle": "idle",
        ":null": null,
        ":sid": sessionId,
        ...(hasCurrentConnection ? { ":online": true, ":connectionId": connectionId } : {}),
      },
    },
  };
}

/** Persist retry ownership with settlement so a short-lived socket cannot lose an archive. */
function terminalHandoffArchiveIntentItem(
  ctx: PlaneStorageCtx,
  archive: ArchiveMetadata,
): Record<string, unknown> {
  return {
    Put: {
      TableName: ctx.tables.archives,
      Item: archive,
    },
  };
}

function terminalHandoffHostLockItem(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    connectionId?: string;
    mainCheckoutRepositoryId?: string;
  },
): Record<string, unknown> {
  if (!opts.mainCheckoutRepositoryId) {
    return {
      ConditionCheck: {
        TableName: ctx.tables.hostLocks,
        Key: { hostId: opts.hostId },
        ConditionExpression: "connectionId = :connectionId",
        ExpressionAttributeValues: { ":connectionId": opts.connectionId },
      },
    };
  }
  return {
    Update: {
      TableName: ctx.tables.hostLocks,
      Key: { hostId: opts.hostId },
      UpdateExpression: "REMOVE mainCheckoutLeases.#repo",
      ConditionExpression:
        "connectionId = :connectionId AND mainCheckoutLeases.#repo.sessionId = :sessionId",
      ExpressionAttributeNames: { "#repo": opts.mainCheckoutRepositoryId },
      ExpressionAttributeValues: {
        ":connectionId": opts.connectionId,
        ":sessionId": opts.sessionId,
      },
    },
  };
}

function expiredTerminalHandoffHostLockItem(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    connectionId?: string;
    mainCheckoutRepositoryId?: string;
  },
): Record<string, unknown> | undefined {
  if (!opts.mainCheckoutRepositoryId) {
    return opts.connectionId === undefined ? undefined : terminalHandoffHostLockItem(ctx, opts);
  }
  return {
    Update: {
      TableName: ctx.tables.hostLocks,
      Key: { hostId: opts.hostId },
      UpdateExpression: "REMOVE mainCheckoutLeases.#repo",
      ConditionExpression: `${opts.connectionId === undefined ? "" : "connectionId = :connectionId AND "}mainCheckoutLeases.#repo.sessionId = :sessionId`,
      ExpressionAttributeNames: { "#repo": opts.mainCheckoutRepositoryId },
      ExpressionAttributeValues: {
        ":sessionId": opts.sessionId,
        ...(opts.connectionId === undefined ? {} : { ":connectionId": opts.connectionId }),
      },
    },
  };
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
    /** Worktree reserved by the matching terminal handoff, if any. */
    worktreeId?: string | null;
    /** Main-checkout repository lease reserved by the matching handoff, if any. */
    mainCheckoutRepositoryId?: string;
    /** Durable retry intent for the transcript archive. */
    archive?: ArchiveMetadata;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          terminalHandoffHostLockItem(ctx, opts),
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: `SET terminalHookHandoffSettled = :settled${opts.result ? ", #result = if_not_exists(#result, :result)" : ""} REMOVE terminalHookHandoff, activeHostId, activeHostOrder${opts.mainCheckoutRepositoryId ? ", mainCheckoutLease, assignmentConnectionId, assignmentSentAt, reconnectDeadlineAt, ackReceivedAt" : ""}`,
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
          ...(opts.worktreeId
            ? [reservedWorktreeReleaseItem(ctx, opts.worktreeId, opts.sessionId, opts.connectionId)]
            : []),
          ...(opts.archive ? [terminalHandoffArchiveIntentItem(ctx, opts.archive)] : []),
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
  opts: {
    sessionId: string;
    handoffId: string;
    expiresAt: string;
    worktreeId?: string | null;
    hostId?: string;
    connectionId?: string;
    mainCheckoutRepositoryId?: string;
    /** Durable retry intent for the transcript archive. */
    archive?: ArchiveMetadata;
  },
): Promise<boolean> {
  try {
    const currentConnectionFence =
      opts.hostId === undefined
        ? []
        : [
            expiredTerminalHandoffHostLockItem(ctx, {
              sessionId: opts.sessionId,
              hostId: opts.hostId,
              ...(opts.connectionId !== undefined ? { connectionId: opts.connectionId } : {}),
              ...(opts.mainCheckoutRepositoryId !== undefined
                ? { mainCheckoutRepositoryId: opts.mainCheckoutRepositoryId }
                : {}),
            }),
          ].filter((item): item is Record<string, unknown> => item !== undefined);
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...currentConnectionFence,
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: `SET terminalHookHandoffExpiredAt = :expiredAt REMOVE terminalHookHandoff, activeHostId, activeHostOrder${opts.mainCheckoutRepositoryId ? ", mainCheckoutLease, assignmentConnectionId, assignmentSentAt, reconnectDeadlineAt, ackReceivedAt" : ""}`,
              ConditionExpression:
                "terminalHookHandoff.handoffId = :handoffId AND terminalHookHandoff.expiresAt = :expiresAt",
              ExpressionAttributeValues: {
                ":handoffId": opts.handoffId,
                ":expiresAt": opts.expiresAt,
                ":expiredAt": opts.expiresAt,
              },
            },
          },
          ...(opts.worktreeId
            ? [reservedWorktreeReleaseItem(ctx, opts.worktreeId, opts.sessionId, opts.connectionId)]
            : []),
          ...(opts.archive ? [terminalHandoffArchiveIntentItem(ctx, opts.archive)] : []),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (!isConditionalTransactionFailed(err)) throw err;
    return false;
  }
}
