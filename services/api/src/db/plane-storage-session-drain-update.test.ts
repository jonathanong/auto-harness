import { describe, expect, it } from "vitest";

import { updateSessionDrain } from "./plane-storage-session-drains.ts";
import type { PlaneStorageCtx, SessionDrainRecord } from "./plane-storage-types.ts";

function record(): SessionDrainRecord {
  return {
    scopeKey: "repo#principal",
    recordKey: "CURRENT",
    operationId: "operation",
    repositoryId: "repo",
    principalId: "principal",
    status: "succeeded",
    requestedAt: "now",
    updatedAt: "now",
    deadlineAt: "later",
    queuedCount: 0,
    runningCount: 0,
    cancelledCount: 3,
  };
}

describe("session drain update fencing", () => {
  it("does not allow a stale count to overwrite a newer cancellation count", async () => {
    let input: Record<string, unknown> | undefined;
    const storage = {
      doc: {
        send: async (command: { input?: Record<string, unknown> }) => {
          input = command.input;
          return {};
        },
      },
      tables: { sessionDrains: "session-drains" },
    } as unknown as PlaneStorageCtx;
    await expect(updateSessionDrain(storage, record())).resolves.toBe(true);
    expect(input?.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Put: expect.objectContaining({
            ConditionExpression: expect.stringContaining("cancelledCount <= :cancelledCount"),
            ExpressionAttributeValues: expect.objectContaining({ ":cancelledCount": 3 }),
          }),
        }),
      ]),
    );
  });
});
