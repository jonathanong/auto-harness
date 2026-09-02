import { describe, expect, it, vi } from "vitest";

import {
  drainCancelScope,
  drainCancelledByClause,
  writeCancelledSessionUpdate,
} from "./plane-storage-session-cancel-write.ts";

describe("cancelled session write helpers", () => {
  it("requires a complete drain scope before incrementing drain counters", () => {
    expect(drainCancelScope({})).toBeUndefined();
    expect(drainCancelScope({ drainOperationId: "op" })).toBeUndefined();
    expect(drainCancelScope({ drainOperationId: "op", drainRepositoryId: "repo" })).toBeUndefined();
    expect(
      drainCancelScope({
        drainOperationId: "op",
        drainRepositoryId: "repo",
        drainPrincipalId: "user",
      }),
    ).toEqual({ repositoryId: "repo", principalId: "user", operationId: "op" });
    expect(drainCancelledByClause()).toBe("");
    expect(drainCancelledByClause("op")).toBe(", cancelledByDrainOperationId = :drainOperationId");
  });

  it("writes a lone update or a drain transaction, and maps conditional failures", async () => {
    const update = {
      TableName: "sessions",
      Key: { id: "s" },
      UpdateExpression: "SET #s = :cancelled",
      ConditionExpression: "#s = :running",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":cancelled": "cancelled", ":running": "running" },
    };
    const marker = {
      sessionId: "s",
      hostId: "host",
      attemptId: "attempt-1",
      now: "2026-01-01T00:00:00.000Z",
    };
    const send = vi.fn().mockResolvedValue({});
    const ctx = {
      doc: { send },
      tables: { sessionDrains: "drains", sessionCancelRedeliveries: "redeliveries" },
    } as never;
    await expect(writeCancelledSessionUpdate(ctx, update, marker)).resolves.toBe(true);
    await expect(
      writeCancelledSessionUpdate(ctx, update, marker, {
        repositoryId: "repo",
        principalId: "user",
        operationId: "op",
      }),
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = send.mock.calls;
    expect(firstCall[0].input.TransactItems).toEqual([
      { Update: update },
      {
        Put: {
          TableName: "redeliveries",
          Item: {
            sessionId: "s",
            hostId: "host",
            attemptId: "attempt-1",
            status: "pending",
            attempts: 0,
            createdAt: marker.now,
            queuedAt: marker.now,
            updatedAt: marker.now,
          },
        },
      },
    ]);
    expect(secondCall[0].input.TransactItems).toHaveLength(4);
    send.mockRejectedValueOnce(
      Object.assign(new Error("busy"), { name: "ConditionalCheckFailedException" }),
    );
    await expect(writeCancelledSessionUpdate(ctx, update, marker)).resolves.toBe(false);
    send.mockRejectedValueOnce(
      Object.assign(new Error("canceled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      }),
    );
    await expect(
      writeCancelledSessionUpdate(ctx, update, marker, {
        repositoryId: "repo",
        principalId: "user",
        operationId: "op",
      }),
    ).resolves.toBe(false);
    send.mockRejectedValueOnce(new Error("throttled"));
    await expect(writeCancelledSessionUpdate(ctx, update, marker)).rejects.toThrow("throttled");
  });
});
