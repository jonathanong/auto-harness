import {
  DescribeTableCommand,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";

const timer = vi.hoisted(() => ({ delay: vi.fn().mockResolvedValue(undefined) }));

vi.mock("node:timers/promises", () => ({ setTimeout: timer.delay }));

import { ensureSessionsParentIndex } from "./db/ensure-session-index.ts";

afterEach(() => timer.delay.mockClear());

describe("ensureSessionsParentIndex", () => {
  it("covers describe failure and an already-existing index", async () => {
    const unavailable = { send: async () => Promise.reject(new Error("offline")) } as never;
    await expect(ensureSessionsParentIndex(unavailable, "Sessions")).resolves.toBeUndefined();

    const commands: unknown[] = [];
    const existing = {
      send: async (command: unknown) => {
        commands.push(command);
        return {
          Table: {
            TableStatus: "ACTIVE",
            GlobalSecondaryIndexes: [
              { IndexName: "parentSessionId-createdOrder", IndexStatus: "ACTIVE" },
            ],
          },
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
      let created = false;
      const client = {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof UpdateTableCommand) {
            created = true;
            return {};
          }
          return {
            Table: {
              TableStatus: "ACTIVE",
              AttributeDefinitions: definitions,
              ...(created
                ? {
                    GlobalSecondaryIndexes: [
                      { IndexName: "parentSessionId-createdOrder", IndexStatus: "ACTIVE" },
                    ],
                  }
                : {}),
            },
          };
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
  ])("waits for and verifies a concurrent migration %o", async (failure) => {
    let describes = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          describes += 1;
          return {
            Table: {
              TableStatus: "ACTIVE",
              ...(describes > 1
                ? {
                    GlobalSecondaryIndexes: [
                      { IndexName: "parentSessionId-createdOrder", IndexStatus: "ACTIVE" },
                    ],
                  }
                : {}),
            },
          };
        }
        throw failure;
      },
    } as never;
    await expect(ensureSessionsParentIndex(client, "Sessions")).resolves.toBeUndefined();
    expect(describes).toBe(2);
  });

  it("waits for a creating index and table before returning", async () => {
    let describes = 0;
    const client = {
      send: async () => {
        describes += 1;
        return {
          Table: {
            TableStatus: describes === 1 ? "UPDATING" : "ACTIVE",
            GlobalSecondaryIndexes: [
              {
                IndexName: "parentSessionId-createdOrder",
                IndexStatus: describes === 1 ? "CREATING" : "ACTIVE",
              },
            ],
          },
        };
      },
    } as never;
    await expect(ensureSessionsParentIndex(client, "Sessions")).resolves.toBeUndefined();
    expect(describes).toBe(2);
  });

  it("propagates unexpected update failures", async () => {
    const client = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: { TableStatus: "ACTIVE" } };
        throw new Error("unexpected update failure");
      },
    } as never;
    await expect(ensureSessionsParentIndex(client, "Sessions")).rejects.toThrow(
      "unexpected update failure",
    );
  });

  it("propagates describe failures after migration has started", async () => {
    const failure = new Error("describe interrupted");
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        calls += 1;
        if (calls === 1 && command instanceof DescribeTableCommand) {
          return { Table: { TableStatus: "ACTIVE" } };
        }
        if (calls === 2 && command instanceof UpdateTableCommand) return {};
        throw failure;
      },
    } as never;

    await expect(ensureSessionsParentIndex(client, "Sessions")).rejects.toBe(failure);
  });

  it("fails after a bounded wait for an index that never becomes active", async () => {
    const client = {
      send: async () => ({
        Table: {
          TableStatus: "UPDATING",
          GlobalSecondaryIndexes: [
            { IndexName: "parentSessionId-createdOrder", IndexStatus: "CREATING" },
          ],
        },
      }),
    } as never;
    await expect(ensureSessionsParentIndex(client, "Sessions")).rejects.toThrow(
      "timed out waiting for parentSessionId-createdOrder to become ACTIVE",
    );
    expect(timer.delay).toHaveBeenCalledTimes(300);
  });
});
