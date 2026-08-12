import { describe, expect, it } from "vitest";

import { listSessionsByRepository } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("DynamoDB repository session pagination", () => {
  it("reads through the repository-createdAt index", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const send = async (command: { input: Record<string, unknown> }) => {
      commands.push(command);
      return commands.length === 1
        ? {
            Items: [{ id: "session-1", repositoryId: "repo-1", createdAt: "2026-01-01" }],
            LastEvaluatedKey: { id: "session-1" },
          }
        : { Items: [{ id: "session-2", repositoryId: "repo-1", createdAt: "2026-01-02" }] };
    };
    const ctx = {
      doc: { send },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionsByRepository(ctx, "repo-1")).resolves.toMatchObject([
      { id: "session-1" },
      { id: "session-2" },
    ]);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.input).toMatchObject({
      IndexName: "repositoryId-createdAt",
      KeyConditionExpression: "repositoryId = :repositoryId",
      ExpressionAttributeValues: { ":repositoryId": "repo-1" },
    });
  });

  it("falls back to a filtered scan while the index is unavailable", async () => {
    let queryAttempts = 0;
    const send = async (command: { input: Record<string, unknown> }) => {
      if (command.input.IndexName === "repositoryId-createdAt") {
        queryAttempts += 1;
        const error = new Error("index is still being created");
        error.name = "ValidationException";
        throw error;
      }
      return {
        Items: [{ id: "session-1", repositoryId: "repo-1", createdAt: "2026-01-01" }],
      };
    };
    const ctx = {
      doc: { send },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionsByRepository(ctx, "repo-1")).resolves.toMatchObject([
      { id: "session-1" },
    ]);
    expect(queryAttempts).toBe(1);
  });
});
