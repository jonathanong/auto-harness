import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { getHostLock } from "./plane-storage-locks.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { getSession } from "./plane-storage-sessions-query.ts";

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
    if (activeFence) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.tables.hostLocks,
                Key: { hostId: activeFence.hostId },
                ConditionExpression: "connectionId = :connectionId",
                ExpressionAttributeValues: { ":connectionId": activeFence.connectionId },
              },
            },
            {
              Update: {
                TableName: ctx.tables.sessions,
                Key: { id: sessionId },
                UpdateExpression: "SET ackReceivedAt = :at REMOVE assignmentSentAt",
                ConditionExpression:
                  "#s = :running" +
                  (attempt ? " AND worktreeId = :worktreeId AND attemptId = :attemptId" : "") +
                  " AND attribute_not_exists(ackReceivedAt)",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":at": attempt?.acknowledgedAt ?? acknowledgedAt,
                  ":running": "running",
                  ...(attempt
                    ? { ":worktreeId": attempt.worktreeId, ":attemptId": attempt.attemptId }
                    : {}),
                },
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
        UpdateExpression: "SET ackReceivedAt = :at REMOVE assignmentSentAt",
        ConditionExpression:
          "#s = :running" +
          (attempt !== null ? " AND worktreeId = :worktreeId AND attemptId = :attemptId" : "") +
          " AND attribute_not_exists(ackReceivedAt)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":at": attempt?.acknowledgedAt ?? acknowledgedAt!,
          ":running": "running",
          ...(attempt !== null
            ? { ":worktreeId": attempt.worktreeId, ":attemptId": attempt.attemptId }
            : {}),
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      // A duplicate ack is a successful no-op, while a late ack for a terminal
      // session is also harmless to the caller.
      const current = await getSession(ctx, sessionId);
      const fenceStillOwnsHost =
        !activeFence || (await getHostLock(ctx, activeFence.hostId)) === activeFence.connectionId;
      if (legacy && activeFence) {
        return (
          current?.ackReceivedAt !== undefined &&
          current.status === "running" &&
          fenceStillOwnsHost &&
          current.hostId === activeFence.hostId &&
          (current.assignmentConnectionId === undefined ||
            current.assignmentConnectionId === activeFence.connectionId)
        );
      }
      const attemptMatches =
        !attempt ||
        (current?.worktreeId === attempt.worktreeId && current.attemptId === attempt.attemptId);
      const fenceMatches =
        !activeFence ||
        (current?.hostId === activeFence.hostId &&
          (current.assignmentConnectionId === undefined ||
            current.assignmentConnectionId === activeFence.connectionId));
      return legacy
        ? current?.ackReceivedAt !== undefined || current?.status !== "running"
        : current?.status === "running" &&
            attemptMatches &&
            fenceStillOwnsHost &&
            fenceMatches &&
            current.ackReceivedAt !== undefined;
    }
    throw err;
  }
}
