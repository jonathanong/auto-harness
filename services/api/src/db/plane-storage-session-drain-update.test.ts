import { describe, expect, it } from "vitest";

import { updateSessionDrain } from "./plane-storage-session-drains.ts";
import type { AuditLogRecord } from "../audit-types.ts";
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

function audit(): AuditLogRecord {
  return {
    id: "audit-session-drain-operation-succeeded",
    createdAt: "now",
    actor: { id: "system", kind: "system", role: "system" },
    action: "session-drain:succeeded",
    resourceType: "repository",
    resourceId: "repo",
    repositoryId: "repo",
    outcome: "success",
    metadata: { operationId: "operation" },
  };
}

describe("session drain update fencing", () => {
  it("requires a durable audit record before a terminal checkpoint", async () => {
    const storage = {
      doc: { send: async () => ({}) },
      tables: { sessionDrains: "session-drains" },
    } as unknown as PlaneStorageCtx;

    await expect(updateSessionDrain(storage, record())).rejects.toThrow(
      "terminal session drain updates require an audit record",
    );
  });

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
    await expect(updateSessionDrain(storage, record(), audit())).resolves.toBe(true);
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
