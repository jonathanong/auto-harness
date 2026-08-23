import { describe, expect, it } from "vitest";

import { listSessionsForDrain } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function context(send: (command: { input: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send },
    tables: { sessions: "Sessions" },
  } as unknown as PlaneStorageCtx;
}

describe("DynamoDB session drain query", () => {
  it("uses active status shards and the sparse attribution index", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const ctx = context(async (command) => {
      commands.push(command);
      if (command.input.IndexName === "cancelledByDrainOperationId-createdAt") {
        return {
          Items: [
            {
              id: "legacy",
              repositoryId: "repo",
              metadata: { createdBy: "principal" },
              status: "cancelled",
              cancelledByDrainOperationId: "operation",
            },
          ],
        };
      }
      return command.input.ExpressionAttributeValues?.[":ss"] === "queued#0"
        ? {
            Items: [
              { id: "owned", repositoryId: "repo", principalId: "principal", status: "queued" },
              { id: "other", repositoryId: "repo", principalId: "other", status: "queued" },
            ],
          }
        : {
            Items: [
              {
                id: "running-other",
                repositoryId: "repo",
                principalId: "other",
                status: "running",
              },
            ],
          };
    });

    await expect(
      listSessionsForDrain(ctx, "repo", "principal", "operation", 1),
    ).resolves.toMatchObject([{ id: "owned" }, { id: "legacy" }]);
    expect(commands).toHaveLength(3);
    expect(commands[0]?.input).toMatchObject({
      IndexName: "statusShard-createdAt",
      KeyConditionExpression: "statusShard = :ss",
      ExpressionAttributeValues: {
        ":repositoryId": "repo",
        ":ss": "queued#0",
      },
    });
    expect(commands[2]?.input).toMatchObject({
      IndexName: "cancelledByDrainOperationId-createdAt",
      KeyConditionExpression: "cancelledByDrainOperationId = :operationId",
      ExpressionAttributeValues: { ":operationId": "operation" },
    });
  });

  it("pages the scoped query", async () => {
    const pages = new Map<string, number>();
    const ctx = context(async (command) => {
      if (command.input.IndexName === "cancelledByDrainOperationId-createdAt") return { Items: [] };
      const key = String(command.input.ExpressionAttributeValues?.[":ss"]);
      const page = pages.get(key) ?? 0;
      pages.set(key, page + 1);
      expect(command.input.ExclusiveStartKey).toEqual(page === 0 ? undefined : { id: "first" });
      if (key !== "queued#0") return { Items: [] };
      return page === 0
        ? {
            Items: [
              { id: "first", repositoryId: "repo", principalId: "principal", status: "queued" },
            ],
            LastEvaluatedKey: { id: "first" },
          }
        : {
            Items: [
              { id: "second", repositoryId: "repo", principalId: "principal", status: "queued" },
            ],
          };
    });

    await expect(
      listSessionsForDrain(ctx, "repo", "principal", "operation", 1),
    ).resolves.toMatchObject([{ id: "first" }, { id: "second" }]);
    expect([...pages.values()].reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  it("falls back safely while the sparse migration index is unavailable", async () => {
    const ctx = context(async (command) => {
      if (command.input.IndexName === "cancelledByDrainOperationId-createdAt") {
        throw { name: "ValidationException" };
      }
      if (command.input.IndexName === "repositoryId-createdAt") {
        return {
          Items: [
            {
              id: "cancelled",
              repositoryId: "repo",
              principalId: "principal",
              status: "cancelled",
              cancelledByDrainOperationId: "operation",
            },
          ],
        };
      }
      return { Items: [] };
    });

    await expect(
      listSessionsForDrain(ctx, "repo", "principal", "operation", 1),
    ).resolves.toMatchObject([{ id: "cancelled" }]);
  });
});
