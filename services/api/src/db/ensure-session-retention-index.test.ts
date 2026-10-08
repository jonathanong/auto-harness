import { describe, expect, it } from "vitest";

import { DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";

import {
  ensureSessionRetentionIndex,
  SESSION_RETENTION_INDEX,
} from "./ensure-session-retention-index.ts";

function updateInput(command: unknown): UpdateTableCommand["input"] {
  if (!(command instanceof UpdateTableCommand)) throw new Error("expected UpdateTableCommand");
  return command.input;
}

describe("ensureSessionRetentionIndex", () => {
  it("leaves an existing retention index unchanged", async () => {
    const commands: unknown[] = [];
    await ensureSessionRetentionIndex(
      {
        send: async (command: unknown) => {
          commands.push(command);
          return {
            Table: {
              GlobalSecondaryIndexes: [{ IndexName: SESSION_RETENTION_INDEX }],
            },
          };
        },
      } as never,
      "Sessions",
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(DescribeTableCommand);
  });

  it("adds the KEYS_ONLY retention index and missing key attributes", async () => {
    const commands: unknown[] = [];
    await ensureSessionRetentionIndex(
      {
        send: async (command: unknown) => {
          commands.push(command);
          return command instanceof DescribeTableCommand
            ? { Table: { AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }] } }
            : {};
        },
      } as never,
      "Sessions",
    );
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBeInstanceOf(UpdateTableCommand);
    expect(updateInput(commands[1])).toEqual({
      TableName: "Sessions",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "statusShard", AttributeType: "S" },
        { AttributeName: "completedAt", AttributeType: "S" },
      ],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: SESSION_RETENTION_INDEX,
            KeySchema: [
              { AttributeName: "statusShard", KeyType: "HASH" },
              { AttributeName: "completedAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "KEYS_ONLY" },
          },
        },
      ],
    });
  });

  it("reuses present attributes without duplicates", async () => {
    let update: UpdateTableCommand | undefined;
    await ensureSessionRetentionIndex(
      {
        send: async (command: unknown) => {
          if (command instanceof DescribeTableCommand) {
            return {
              Table: {
                AttributeDefinitions: [
                  { AttributeName: "statusShard", AttributeType: "S" },
                  { AttributeName: "completedAt", AttributeType: "S" },
                ],
              },
            };
          }
          update = command as UpdateTableCommand;
          return {};
        },
      } as never,
      "Sessions",
    );
    const definitions = updateInput(update).AttributeDefinitions ?? [];
    expect(
      definitions.filter((attribute) => attribute.AttributeName === "statusShard"),
    ).toHaveLength(1);
    expect(
      definitions.filter((attribute) => attribute.AttributeName === "completedAt"),
    ).toHaveLength(1);
  });

  it.each(["ResourceInUseException", "LimitExceededException"])(
    "treats concurrent %s responses as another bootstrap creating the index",
    async (name) => {
      const commands: unknown[] = [];
      await expect(
        ensureSessionRetentionIndex(
          {
            send: async (command: unknown) => {
              commands.push(command);
              if (command instanceof DescribeTableCommand) return { Table: {} };
              const error = new Error(name);
              error.name = name;
              throw error;
            },
          } as never,
          "Sessions",
        ),
      ).resolves.toBeUndefined();
      expect(commands).toHaveLength(2);
    },
  );

  it("surfaces hard update errors", async () => {
    const failure = new Error("access denied");
    await expect(
      ensureSessionRetentionIndex(
        {
          send: async (command: unknown) => {
            if (command instanceof DescribeTableCommand) return { Table: {} };
            throw failure;
          },
        } as never,
        "Sessions",
      ),
    ).rejects.toBe(failure);
  });
});
