import { DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureRepositoryCatalogIndex } from "./ensure-repository-catalog-index.ts";

const TABLE = "Repositories";
const ACTIVE_INDEX = {
  IndexName: "catalogScope-catalogSort",
  IndexStatus: "ACTIVE",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ensureRepositoryCatalogIndex", () => {
  it("backfills every legacy scan page after the catalog index is active", async () => {
    const mockedClient = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          return { Table: { GlobalSecondaryIndexes: [ACTIVE_INDEX] } };
        }
        throw new Error("unexpected control-plane command");
      }),
    } as never;
    const doc = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [
            { id: "repository-a", name: "alpha" },
            { id: 1, name: "invalid-id" },
            { id: "invalid-name", name: null },
            {
              id: "repository-current",
              name: "current",
              catalogScope: "repositories",
              catalogSort: "current\0repository-current",
            },
          ],
          LastEvaluatedKey: { id: "repository-a" },
        })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValue({}),
    } as never;

    await ensureRepositoryCatalogIndex(mockedClient, doc, TABLE);

    expect(doc.send.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
    expect(doc.send.mock.calls[1]?.[0]).toBeInstanceOf(UpdateCommand);
    expect(doc.send.mock.calls[1]?.[0].input).toMatchObject({
      TableName: TABLE,
      Key: { id: "repository-a" },
      ExpressionAttributeValues: { ":scope": "repositories", ":sort": "alpha\0repository-a" },
    });
    expect(doc.send.mock.calls[2]?.[0].input.ExclusiveStartKey).toEqual({ id: "repository-a" });
  });

  it("creates the index when a legacy table has no catalog access path", async () => {
    let described = 0;
    const mockedClient = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          described += 1;
          return {
            Table: {
              AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
              GlobalSecondaryIndexes: described === 1 ? [] : [ACTIVE_INDEX],
            },
          };
        }
        if (command instanceof UpdateTableCommand) return {};
        throw new Error("unexpected control-plane command");
      }),
    } as never;
    const doc = { send: vi.fn().mockResolvedValue({ Items: [] }) } as never;

    await ensureRepositoryCatalogIndex(mockedClient, doc, TABLE);

    expect(mockedClient.send.mock.calls[1]?.[0]).toBeInstanceOf(UpdateTableCommand);
    expect(mockedClient.send.mock.calls[1]?.[0].input).toMatchObject({
      TableName: TABLE,
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: "catalogScope", AttributeType: "S" },
        { AttributeName: "catalogSort", AttributeType: "S" },
      ]),
    });
  });

  it("returns when the repositories table is unavailable", async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error("missing")) } as never;
    const doc = { send: vi.fn() } as never;

    await expect(ensureRepositoryCatalogIndex(client, doc, TABLE)).resolves.toBeUndefined();
    expect(doc.send).not.toHaveBeenCalled();
  });

  it("accepts an index without a reported status", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        Table: { GlobalSecondaryIndexes: [{ IndexName: "catalogScope-catalogSort" }] },
      }),
    } as never;
    const doc = { send: vi.fn().mockResolvedValue({}) } as never;

    await expect(ensureRepositoryCatalogIndex(client, doc, TABLE)).resolves.toBeUndefined();
  });

  it("waits through a concurrent index creation limit", async () => {
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Table: {
            AttributeDefinitions: [
              { AttributeName: "catalogScope", AttributeType: "S" },
              { AttributeName: "catalogSort", AttributeType: "S" },
            ],
          },
        })
        .mockRejectedValueOnce({ name: "LimitExceededException" })
        .mockResolvedValue({ Table: { GlobalSecondaryIndexes: [ACTIVE_INDEX] } }),
    } as never;
    const doc = { send: vi.fn().mockResolvedValue({ Items: [] }) } as never;

    await expect(ensureRepositoryCatalogIndex(client, doc, TABLE)).resolves.toBeUndefined();
  });

  it("propagates an unexpected index creation failure", async () => {
    const failure = new Error("denied");
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ Table: { AttributeDefinitions: [] } })
        .mockRejectedValueOnce(failure),
    } as never;

    await expect(
      ensureRepositoryCatalogIndex(client, { send: vi.fn() } as never, TABLE),
    ).rejects.toBe(failure);
  });

  it("fails after the bounded index creation retry deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(60_000);
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ Table: { AttributeDefinitions: [] } })
        .mockRejectedValueOnce({ name: "LimitExceededException" }),
    } as never;

    await expect(
      ensureRepositoryCatalogIndex(client, { send: vi.fn() } as never, TABLE),
    ).rejects.toThrow(`repository catalog index could not be created: ${TABLE}`);
  });

  it("fails when an existing index never becomes active", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(60_000);
    const client = {
      send: vi.fn().mockResolvedValue({
        Table: {
          GlobalSecondaryIndexes: [
            { IndexName: "catalogScope-catalogSort", IndexStatus: "CREATING" },
          ],
        },
      }),
    } as never;

    await expect(
      ensureRepositoryCatalogIndex(client, { send: vi.fn() } as never, TABLE),
    ).rejects.toThrow(`repository catalog index did not become active: ${TABLE}`);
  });

  it("polls while a catalog index is still creating", async () => {
    vi.useFakeTimers();
    const creating = {
      Table: {
        GlobalSecondaryIndexes: [
          { IndexName: "catalogScope-catalogSort", IndexStatus: "CREATING" },
        ],
      },
    };
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce(creating)
        .mockResolvedValueOnce(creating)
        .mockResolvedValue({ Table: { GlobalSecondaryIndexes: [ACTIVE_INDEX] } }),
    } as never;
    const doc = { send: vi.fn().mockResolvedValue({ Items: [] }) } as never;

    const pending = ensureRepositoryCatalogIndex(client, doc, TABLE);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeUndefined();
  });
});
