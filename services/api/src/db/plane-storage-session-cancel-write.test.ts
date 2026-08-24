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
    const send = vi.fn().mockResolvedValue({});
    const ctx = { doc: { send }, tables: { sessionDrains: "drains" } } as never;
    await expect(writeCancelledSessionUpdate(ctx, update)).resolves.toBe(true);
    await expect(
      writeCancelledSessionUpdate(ctx, update, {
        repositoryId: "repo",
        principalId: "user",
        operationId: "op",
      }),
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockRejectedValueOnce(
      Object.assign(new Error("busy"), { name: "ConditionalCheckFailedException" }),
    );
    await expect(writeCancelledSessionUpdate(ctx, update)).resolves.toBe(false);
    send.mockRejectedValueOnce(
      Object.assign(new Error("canceled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      }),
    );
    await expect(
      writeCancelledSessionUpdate(ctx, update, {
        repositoryId: "repo",
        principalId: "user",
        operationId: "op",
      }),
    ).resolves.toBe(false);
    send.mockRejectedValueOnce(new Error("throttled"));
    await expect(writeCancelledSessionUpdate(ctx, update)).rejects.toThrow("throttled");
  });
});
