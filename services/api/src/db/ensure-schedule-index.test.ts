import { DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { ensureSchedulesRepositoryIndex } from "./ensure-session-index.ts";

describe("ensureSchedulesRepositoryIndex", () => {
  it("starts the repository/id index without blocking on its backfill", async () => {
    const commands: unknown[] = [];
    const send = async (command: unknown) => {
      commands.push(command);
      return command instanceof DescribeTableCommand ? { Table: { AttributeDefinitions: [] } } : {};
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

  it("does not update an existing index while it is backfilling", async () => {
    const send = vi.fn().mockResolvedValue({
      Table: {
        GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id", IndexStatus: "CREATING" }],
      },
    });

    await ensureSchedulesRepositoryIndex({ send } as never, "Schedules");

    expect(send).toHaveBeenCalledOnce();
  });

  it("fails setup when the Schedules table cannot be described", async () => {
    const error = new Error("describe unavailable");
    const send = vi.fn().mockRejectedValue(error);

    await expect(ensureSchedulesRepositoryIndex({ send } as never, "Schedules")).rejects.toBe(
      error,
    );
  });

  it("fails setup when index creation is throttled", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Table: {} })
      .mockRejectedValueOnce({ name: "LimitExceededException" });

    await expect(
      ensureSchedulesRepositoryIndex({ send } as never, "Schedules"),
    ).rejects.toMatchObject({ name: "LimitExceededException" });
  });
});
