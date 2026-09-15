import {
  DescribeTableCommand,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";

import { describe, expect, it } from "vitest";

import { SESSIONS_QUEUE_ORDER_INDEX } from "../control-plane-ordering.ts";
import { ensureSessionsQueueOrderIndex } from "./ensure-queue-order-index.ts";

describe("ensureSessionsQueueOrderIndex", () => {
  it("leaves a table alone when it cannot be described", async () => {
    const unavailable = {
      send: async () => {
        throw new Error("offline");
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(unavailable, "Sessions")).resolves.toBeUndefined();
  });

  it("accepts a concurrent index migration without replacing existing definitions", async () => {
    const commands: unknown[] = [];
    const mockedClient = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof DescribeTableCommand) {
          return {
            Table: {
              AttributeDefinitions: [
                { AttributeName: "statusShard", AttributeType: ScalarAttributeType.S },
              ],
            },
          };
        }
        throw { name: "LimitExceededException" };
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
    expect(commands).toEqual([expect.any(DescribeTableCommand), expect.any(UpdateTableCommand)]);
  });

  it("accepts an index migration already in progress", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new ResourceInUseException({ $metadata: {}, message: "busy" });
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
  });

  it("propagates an unexpected index update failure", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new Error("unexpected update failure");
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).rejects.toThrow(
      "unexpected update failure",
    );
  });

  it("creates the queue-order index when DescribeTable omits it", async () => {
    const commands: unknown[] = [];
    const mockedClient = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof DescribeTableCommand) return { Table: {} };
        return {};
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
    expect(commands).toEqual([expect.any(DescribeTableCommand), expect.any(UpdateTableCommand)]);
  });

  it("skips creating the index when it already exists", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          return {
            Table: { GlobalSecondaryIndexes: [{ IndexName: SESSIONS_QUEUE_ORDER_INDEX }] },
          };
        }
        throw new Error("should not update");
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
  });

  it("reuses an existing queueOrder attribute definition", async () => {
    const commands: unknown[] = [];
    const mockedClient = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof DescribeTableCommand) {
          return {
            Table: {
              AttributeDefinitions: [
                { AttributeName: "queueOrder", AttributeType: ScalarAttributeType.S },
              ],
            },
          };
        }
        throw { name: "LimitExceededException" };
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
    expect((commands[1] as UpdateTableCommand).input.AttributeDefinitions).toEqual([
      { AttributeName: "queueOrder", AttributeType: "S" },
    ]);
  });
});
