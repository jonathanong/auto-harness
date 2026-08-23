import { DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { ensureSchedulesRepositoryIndex } from "./ensure-session-index.ts";

describe("ensureSchedulesRepositoryIndex", () => {
  it("adds the repository/id index and waits until it is active", async () => {
    const commands: unknown[] = [];
    let described = 0;
    const send = async (command: unknown) => {
      commands.push(command);
      if (!(command instanceof DescribeTableCommand)) return {};
      described += 1;
      return described === 1
        ? { Table: { AttributeDefinitions: [] } }
        : {
            Table: {
              GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id", IndexStatus: "ACTIVE" }],
            },
          };
    };

    await ensureSchedulesRepositoryIndex({ send } as never, "Schedules");

    expect((commands[1] as UpdateTableCommand).input).toMatchObject({
      TableName: "Schedules",
      AttributeDefinitions: [{ AttributeName: "repositoryId", AttributeType: "S" }],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: "repositoryId-id",
            KeySchema: [
              { AttributeName: "repositoryId", KeyType: "HASH" },
              { AttributeName: "id", KeyType: "RANGE" },
            ],
          },
        },
      ],
    });
  });

  it("waits for a creating index", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Table: {
          GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id", IndexStatus: "CREATING" }],
        },
      })
      .mockResolvedValueOnce({
        Table: {
          GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id", IndexStatus: "ACTIVE" }],
        },
      });
    try {
      const migration = ensureSchedulesRepositoryIndex({ send } as never, "Schedules");
      await vi.advanceTimersByTimeAsync(200);
      await expect(migration).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails startup when the index never becomes active", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({
      Table: {
        GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id", IndexStatus: "CREATING" }],
      },
    });
    try {
      const migration = ensureSchedulesRepositoryIndex({ send } as never, "Schedules");
      const rejection = expect(migration).rejects.toThrow("timed out waiting for DynamoDB index");
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not update an existing index without a reported status", async () => {
    const send = vi.fn().mockResolvedValue({
      Table: { GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id" }] },
    });

    await ensureSchedulesRepositoryIndex({ send } as never, "Schedules");

    expect(send).toHaveBeenCalledOnce();
  });

  it("rechecks a concurrent migration until the index is active", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Table: {} })
      .mockRejectedValueOnce({ name: "LimitExceededException" })
      .mockResolvedValueOnce({
        Table: {
          GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id", IndexStatus: "ACTIVE" }],
        },
      });
    try {
      const migration = ensureSchedulesRepositoryIndex({ send } as never, "Schedules");
      await vi.advanceTimersByTimeAsync(200);
      await expect(migration).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
