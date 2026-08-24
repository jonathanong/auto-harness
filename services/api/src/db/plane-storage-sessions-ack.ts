import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { getHostLock } from "./plane-storage-locks.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import type { SessionRecord } from "./types.ts";

type AckAttempt = {
  sessionId: string;
  worktreeId: string | null;
  attemptId: string;
  acknowledgedAt: string;
  fence?: { hostId: string; connectionId: string };
};

function ackUpdate(
  ctx: PlaneStorageCtx,
  sessionId: string,
  attempt: AckAttempt | null,
  at?: string,
) {
  return {
    TableName: ctx.tables.sessions,
    Key: { id: sessionId },
    UpdateExpression: "SET ackReceivedAt = :at REMOVE assignmentSentAt",
    ConditionExpression:
      "#s = :running" +
      (attempt ? " AND worktreeId = :worktreeId AND attemptId = :attemptId" : "") +
      " AND attribute_not_exists(ackReceivedAt)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":at": attempt?.acknowledgedAt ?? at,
      ":running": "running",
      ...(attempt ? { ":worktreeId": attempt.worktreeId, ":attemptId": attempt.attemptId } : {}),
    },
  };
}

async function writeAck(
  ctx: PlaneStorageCtx,
  sessionId: string,
  attempt: AckAttempt | null,
  fence: { hostId: string; connectionId: string } | undefined,
  at?: string,
): Promise<void> {
  const update = ackUpdate(ctx, sessionId, attempt, at);
  if (!fence) {
    await ctx.doc.send(new UpdateCommand(update));
    return;
  }
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
        { Update: update },
      ],
    }),
  );
}

function assignmentMatchesFence(
  current: SessionRecord | null,
  fence: { hostId: string; connectionId: string },
): boolean {
  if (current?.hostId !== fence.hostId) return false;
  return (
    current.assignmentConnectionId === undefined ||
    current.assignmentConnectionId === fence.connectionId
  );
}

function modernAckConflictSucceeded(
  current: Awaited<ReturnType<typeof getSession>>,
  attempt: AckAttempt | null,
  fence: { hostId: string; connectionId: string } | undefined,
  fenceStillOwnsHost: boolean,
): boolean {
  if (current?.status !== "running" || current.ackReceivedAt === undefined) return false;
  if (
    attempt &&
    (current.worktreeId !== attempt.worktreeId || current.attemptId !== attempt.attemptId)
  ) {
    return false;
  }
  if (!fenceStillOwnsHost) return false;
  return !fence || assignmentMatchesFence(current, fence);
}

async function ackConflictSucceeded(
  ctx: PlaneStorageCtx,
  sessionId: string,
  attempt: AckAttempt | null,
  fence: { hostId: string; connectionId: string } | undefined,
  legacy: boolean,
): Promise<boolean> {
  const current = await getSession(ctx, sessionId);
  const fenceStillOwnsHost =
    !fence || (await getHostLock(ctx, fence.hostId)) === fence.connectionId;
  if (legacy && fence) {
    if (current?.ackReceivedAt === undefined || current.status !== "running") return false;
    return fenceStillOwnsHost && assignmentMatchesFence(current, fence);
  }
  if (legacy) return current?.ackReceivedAt !== undefined || current?.status !== "running";
  return modernAckConflictSucceeded(current, attempt, fence, fenceStillOwnsHost);
}

/** Idempotent acknowledgement of an assigned running session. */
export async function acknowledgeSession(
  ctx: PlaneStorageCtx,
  sessionId: string,
  acknowledgedAt: string,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean>;
export async function acknowledgeSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string | null;
    attemptId: string;
    acknowledgedAt: string;
    fence?: { hostId: string; connectionId: string };
  },
): Promise<boolean>;
export async function acknowledgeSession(
  ctx: PlaneStorageCtx,
  arg:
    | string
    | {
        sessionId: string;
        worktreeId: string | null;
        attemptId: string;
        acknowledgedAt: string;
        fence?: { hostId: string; connectionId: string };
      },
  acknowledgedAt?: string,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean> {
  const legacy = typeof arg === "string";
  const sessionId = legacy ? arg : arg.sessionId;
  const attempt = legacy ? null : arg;
  const activeFence = legacy ? fence : arg.fence;
  try {
    await writeAck(ctx, sessionId, attempt, activeFence, acknowledgedAt);
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      // A duplicate ack is a successful no-op, while a late ack for a terminal
      // session is also harmless to the caller.
      return ackConflictSucceeded(ctx, sessionId, attempt, activeFence, legacy);
    }
    throw err;
  }
}
