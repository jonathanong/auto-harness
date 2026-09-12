import {
  DescribeTableCommand,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import { ensureSessionsParentIndex } from "./db/ensure-session-index.ts";

describe("ensureSessionsParentIndex", () => {
  it("covers describe failure and an already-existing index", async () => {
    const unavailable = { send: async () => Promise.reject(new Error("offline")) } as never;
    await expect(ensureSessionsParentIndex(unavailable, "Sessions")).resolves.toBeUndefined();

    const commands: unknown[] = [];
    const existing = {
      send: async (command: unknown) => {
        commands.push(command);
        return {
          Table: { GlobalSecondaryIndexes: [{ IndexName: "parentSessionId-createdOrder" }] },
        };
      },
    } as never;
    await ensureSessionsParentIndex(existing, "Sessions");
    expect(commands).toEqual([expect.any(DescribeTableCommand)]);
  });

  it("creates the index with and without an existing parent definition", async () => {
    for (const definitions of [
      [{ AttributeName: "createdOrder", AttributeType: ScalarAttributeType.S }],
      [{ AttributeName: "parentSessionId", AttributeType: ScalarAttributeType.S }],
    ]) {
      const commands: unknown[] = [];
      const client = {
        send: async (command: unknown) => {
          commands.push(command);
          return command instanceof DescribeTableCommand
            ? { Table: { AttributeDefinitions: definitions } }
            : {};
        },
      } as never;
      await ensureSessionsParentIndex(client, "Sessions");
      const input = (commands[1] as UpdateTableCommand).input;
      expect(input.GlobalSecondaryIndexUpdates).toMatchObject([
        {
          Create: {
            IndexName: "parentSessionId-createdOrder",
            KeySchema: [
              { AttributeName: "parentSessionId", KeyType: "HASH" },
              { AttributeName: "createdOrder", KeyType: "RANGE" },
            ],
          },
        },
      ]);
      expect(
        input.AttributeDefinitions?.filter((item) => item.AttributeName === "parentSessionId"),
      ).toHaveLength(1);
    }
  });

  it.each([
    [new ResourceInUseException({ $metadata: {}, message: "busy" })],
    [{ name: "LimitExceededException" }],
  ])("accepts concurrent migration failure %o", async (failure) => {
    const client = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw failure;
      },
    } as never;
    await expect(ensureSessionsParentIndex(client, "Sessions")).resolves.toBeUndefined();
  });

  it("propagates unexpected update failures", async () => {
    const client = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new Error("unexpected update failure");
      },
    } as never;
    await expect(ensureSessionsParentIndex(client, "Sessions")).rejects.toThrow(
      "unexpected update failure",
    );
  });
});
