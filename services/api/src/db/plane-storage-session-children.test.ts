import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { listSessionChildren } from "./plane-storage-sessions-query.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("session child storage pages", () => {
  it("uses one bounded parent-index query and returns its continuation key", async () => {
    const nextKey = { id: "child-1", parentSessionId: "parent", createdOrder: "now#child-1" };
    const send = vi.fn(async () => ({ Items: [], LastEvaluatedKey: nextKey }));
    const ctx = {
      doc: { send },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionChildren(ctx, "parent", 7, { id: "before" })).resolves.toEqual({
      items: [],
      nextKey,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect((command as QueryCommand).input).toMatchObject({
      TableName: "Sessions",
      IndexName: "parentSessionId-createdOrder",
      Limit: 7,
      ExclusiveStartKey: { id: "before" },
      ScanIndexForward: false,
    });
  });
});
