import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { isConditionalTransactionFailed } from "./plane-storage-types.ts";
import type { ReconnectSession } from "./plane-storage-reconnect.ts";

/**
 * Undo one successful reconnect confirmation while the same registration
 * lease still owns the host. Reconciliation can confirm several reported
 * sessions before a later report loses a grace-sweep race; restoring the
 * exact old deadline and connection fences keeps those earlier sessions in
 * their original reconnect-pending state without extending their grace.
 */
export async function restoreReconnectPending(
  ctx: PlaneStorageCtx,
  opts: ReconnectSession & {
    previousDeadlineAt?: string;
    previousAssignmentConnectionId?: string;
    previousWorktreeConnectionId?: string;
  },
): Promise<boolean> {
  // Keep one no-op-stable SET so legacy rows with neither optional field can
  // still use a valid DynamoDB update expression while removing the fields
  // introduced by the failed confirmation.
  const sessionSets = ["hostId = :hostId"];
  const sessionRemoves: string[] = [];
  const sessionValues: Record<string, unknown> = {
    ":running": "running",
    ":hostId": opts.hostId,
    ":worktreeId": opts.worktreeId,
    ":connectionId": opts.connectionId,
  };
  if (opts.previousDeadlineAt !== undefined) {
    sessionSets.push("reconnectDeadlineAt = :previousDeadline");
    sessionValues[":previousDeadline"] = opts.previousDeadlineAt;
  } else {
    sessionRemoves.push("reconnectDeadlineAt");
  }
  if (opts.previousAssignmentConnectionId !== undefined) {
    sessionSets.push("assignmentConnectionId = :previousAssignmentConnectionId");
    sessionValues[":previousAssignmentConnectionId"] = opts.previousAssignmentConnectionId;
  } else {
    sessionRemoves.push("assignmentConnectionId");
  }
  const worktreeSets = ["#o = :offline"];
  const worktreeRemoves: string[] = [];
  const worktreeValues: Record<string, unknown> = {
    ":offline": false,
    ":sessionId": opts.sessionId,
    ":connectionId": opts.connectionId,
  };
  if (opts.previousWorktreeConnectionId !== undefined) {
    worktreeSets.push("connectionId = :previousWorktreeConnectionId");
    worktreeValues[":previousWorktreeConnectionId"] = opts.previousWorktreeConnectionId;
  } else {
    worktreeRemoves.push("connectionId");
  }
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
              UpdateExpression:
                `SET ${sessionSets.join(", ")}` +
                (sessionRemoves.length > 0 ? ` REMOVE ${sessionRemoves.join(", ")}` : ""),
              ConditionExpression:
                "#s = :running AND hostId = :hostId AND worktreeId = :worktreeId" +
                " AND assignmentConnectionId = :connectionId" +
                " AND attribute_not_exists(reconnectDeadlineAt)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: sessionValues,
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression:
                `SET ${worktreeSets.join(", ")}` +
                (worktreeRemoves.length > 0 ? ` REMOVE ${worktreeRemoves.join(", ")}` : ""),
              ConditionExpression: "currentSessionId = :sessionId AND connectionId = :connectionId",
              ExpressionAttributeNames: { "#o": "online" },
              ExpressionAttributeValues: worktreeValues,
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
