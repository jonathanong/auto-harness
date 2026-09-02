import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";

/**
 * Durable marker for an operator-initiated `session:cancel` push to a host.
 * `handleCancel` on the host daemon is idempotent (it aborts an already-aborted
 * controller as a no-op), so redelivery needs no ack/fence on the host side —
 * only a conditionally-claimed attempt counter, to keep the bound accurate
 * under overlapping cron invocations.
 */
export type CancelRedeliveryRecord = {
  sessionId: string;
  hostId: string;
  attemptId: string;
  status: "pending";
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

function record(item: Record<string, unknown>): CancelRedeliveryRecord {
  return item as unknown as CancelRedeliveryRecord;
}

export async function recordPendingCancelRedelivery(
  ctx: PlaneStorageCtx,
  input: { sessionId: string; hostId: string; attemptId: string; now: string },
): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessionCancelRedeliveries,
      Item: {
        sessionId: input.sessionId,
        hostId: input.hostId,
        attemptId: input.attemptId,
        status: "pending",
        attempts: 0,
        createdAt: input.now,
        updatedAt: input.now,
      },
    }),
  );
}

export async function listPendingCancelRedeliveries(
  ctx: PlaneStorageCtx,
  limit: number,
): Promise<CancelRedeliveryRecord[]> {
  const response = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessionCancelRedeliveries,
      IndexName: "status-createdAt",
      KeyConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "pending" },
      Limit: limit,
      ScanIndexForward: true,
    }),
  );
  return (response.Items ?? []).map(record);
}

/**
 * Atomically claims one redelivery attempt, returning `false` (no dispatch should
 * follow) when a concurrent cron invocation already claimed this tick or the
 * attempt limit was already reached. Guards against two overlapping cron runs
 * both reading `attempts` below the limit and both dispatching.
 */
export async function claimCancelRedeliveryAttempt(
  ctx: PlaneStorageCtx,
  sessionId: string,
  now: string,
  maxAttempts: number,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessionCancelRedeliveries,
        Key: { sessionId },
        UpdateExpression: "SET attempts = attempts + :one, updatedAt = :now",
        ConditionExpression: "attempts < :max",
        ExpressionAttributeValues: { ":one": 1, ":now": now, ":max": maxAttempts },
      }),
    );
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error) {
      if ((error as { name?: unknown }).name === "ConditionalCheckFailedException") return false;
    }
    throw error;
  }
}

export async function clearPendingCancelRedelivery(
  ctx: PlaneStorageCtx,
  sessionId: string,
): Promise<void> {
  await ctx.doc.send(
    new DeleteCommand({
      TableName: ctx.tables.sessionCancelRedeliveries,
      Key: { sessionId },
    }),
  );
}
