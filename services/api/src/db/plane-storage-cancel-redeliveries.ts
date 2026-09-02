import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

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
  queuedAt: string;
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
        queuedAt: input.now,
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
      IndexName: "status-queuedAt",
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
 * Push a candidate that can't be redelivered yet (host disconnected) to the back of the
 * `status-queuedAt` index by bumping its `queuedAt` cursor to now. Without this, a run of
 * ≥`limit` disconnected-host rows would occupy every oldest-page query forever — since they
 * never clear on their own — permanently starving any newer, deliverable candidate queued
 * behind them. Mirrors `releaseArchiveRetry`'s `retryOrder` bump for the same reason.
 */
export async function deferPendingCancelRedelivery(
  ctx: PlaneStorageCtx,
  sessionId: string,
  now: string,
): Promise<void> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessionCancelRedeliveries,
        Key: { sessionId },
        UpdateExpression: "SET queuedAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_exists(sessionId) AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":now": now, ":pending": "pending" },
      }),
    );
  } catch (error) {
    if (isConditionalFailed(error)) return;
    throw error;
  }
}

/**
 * Atomically claims one redelivery attempt, returning `false` (no dispatch should
 * follow) once the attempt limit is reached. The conditional write bounds the
 * total attempts at `maxAttempts` even under overlapping cron invocations, but
 * does not fence a single invocation: two overlapping invocations racing this
 * same row can each observe `attempts < max` and each successfully claim and
 * dispatch. That is acceptable because `session:cancel` redelivery is
 * idempotent on the host (see `redeliverPendingCancels`'s host-daemon comment),
 * so a few near-simultaneous redeliveries are harmless — only the count, not
 * the pacing, needs to stay bounded.
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
