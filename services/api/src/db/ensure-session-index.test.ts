import {
  DescribeTableCommand,
  ResourceInUseException,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import { ensureSessionsRepositoryIndex } from "./ensure-session-index.ts";

type Call = DescribeTableCommand | UpdateTableCommand;

function client(send: (command: Call) => Promise<unknown>): DynamoDBClient {
  return { send } as unknown as DynamoDBClient;
}

describe("ensureSessionsRepositoryIndex", () => {
  it("adds the repository index and preserves existing attribute definitions", async () => {
    const calls: Call[] = [];
    await ensureSessionsRepositoryIndex(
      client(async (command) => {
        calls.push(command);
        if (command instanceof DescribeTableCommand) {
          return { Table: { AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }] } };
        }
        return {};
      }),
      "Sessions",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeInstanceOf(UpdateTableCommand);
    expect((calls[1] as UpdateTableCommand).input).toMatchObject({
      TableName: "Sessions",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "repositoryId", AttributeType: "S" },
      ],
      GlobalSecondaryIndexUpdates: [{ Create: { IndexName: "repositoryId-createdAt" } }],
    });
  });

  it("does nothing when describe fails or the index already exists", async () => {
    const unavailable = client(async () => Promise.reject(new Error("missing")));
    await expect(ensureSessionsRepositoryIndex(unavailable, "Sessions")).resolves.toBeUndefined();
    const calls: Call[] = [];
    await ensureSessionsRepositoryIndex(
      client(async (command) => {
        calls.push(command);
        return { Table: { GlobalSecondaryIndexes: [{ IndexName: "repositoryId-createdAt" }] } };
      }),
      "Sessions",
    );
    expect(calls).toHaveLength(1);
  });

  it("keeps an existing repository definition and tolerates concurrent creation", async () => {
    const calls: Call[] = [];
    await expect(
      ensureSessionsRepositoryIndex(
        client(async (command) => {
          calls.push(command);
          if (command instanceof DescribeTableCommand) {
            return {
              Table: {
                AttributeDefinitions: [{ AttributeName: "repositoryId", AttributeType: "S" }],
              },
            };
          }
          throw new ResourceInUseException({ $metadata: {}, message: "creating" });
        }),
        "Sessions",
      ),
    ).resolves.toBeUndefined();
    expect((calls[1] as UpdateTableCommand).input.AttributeDefinitions).toEqual([
      { AttributeName: "repositoryId", AttributeType: "S" },
    ]);
  });

  it("propagates an unexpected update failure", async () => {
    await expect(
      ensureSessionsRepositoryIndex(
        client(async (command) => {
          if (command instanceof DescribeTableCommand) return { Table: {} };
          throw new Error("broken");
        }),
        "Sessions",
      ),
    ).rejects.toThrow("broken");
  });
});
