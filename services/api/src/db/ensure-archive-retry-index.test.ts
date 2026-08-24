import { describe, expect, it } from "vitest";

import {
  backfillArchiveRetryIndexPage,
  ensureArchivesRetryIndex,
} from "./ensure-archive-retry-index.ts";

const tables = { archives: "Archives", sessionDrains: "SessionDrains" };

describe("archive retry migration", () => {
  it("ignores an unavailable table and an index that is already present", async () => {
    await expect(
      ensureArchivesRetryIndex(
        { send: async () => Promise.reject(new Error("table unavailable")) } as never,
        "Archives",
      ),
    ).resolves.toBeUndefined();
    await expect(
      ensureArchivesRetryIndex(
        {
          send: async () => ({
            Table: { GlobalSecondaryIndexes: [{ IndexName: "retryState-retryOrder" }] },
          }),
        } as never,
        "Archives",
      ),
    ).resolves.toBeUndefined();
  });

  it("creates the retry index and tolerates an in-flight index update", async () => {
    const updates: unknown[] = [];
    await expect(
      ensureArchivesRetryIndex(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            if (command.input.TableName && command.input.AttributeDefinitions === undefined) {
              return {
                Table: { AttributeDefinitions: [{ AttributeName: "key", AttributeType: "S" }] },
              };
            }
            updates.push(command);
            throw Object.assign(new Error("update in progress"), {
              name: "LimitExceededException",
            });
          },
        } as never,
        "Archives",
      ),
    ).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
  });

  it("rethrows an unexpected index update failure", async () => {
    await expect(
      ensureArchivesRetryIndex(
        {
          send: async (command: { input: Record<string, unknown> }) =>
            command.input.AttributeDefinitions === undefined
              ? { Table: {} }
              : Promise.reject(new Error("permission denied")),
        } as never,
        "Archives",
      ),
    ).rejects.toThrow("permission denied");
  });

  it("rescans after readiness so a legacy writer cannot leave an unindexed row behind", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        calls.push(command);
        if (!command.input.UpdateExpression && command.input.TableName === "SessionDrains") {
          return { Item: { recordType: "archive-retry-v1" } };
        }
        if (command.input.UpdateExpression?.toString().includes("ADD fence")) {
          return { Attributes: { fence: 1 } };
        }
        if (command.input.TableName === "Archives" && command.input.ConsistentRead) {
          return {
            Items: [
              {
                key: "sessions/s/logs.jsonl",
                objectStored: false,
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (command.input.TableName === "Archives") return {};
        return {};
      },
    } as never;

    await expect(backfillArchiveRetryIndexPage(doc, tables)).resolves.toBe(true);

    const scans = calls.filter(
      (call) => call.input.TableName === "Archives" && call.input.ConsistentRead,
    );
    expect(scans).toHaveLength(1);
    expect(scans[0]?.input).toMatchObject({ ConsistentRead: true, Limit: 100 });
    expect(
      calls.some((call) => call.input.UpdateExpression?.toString().includes("SET retryState")),
    ).toBe(true);
  });

  it("returns false when another migration worker owns the lease", async () => {
    const conditional = Object.assign(new Error("lease busy"), {
      name: "ConditionalCheckFailedException",
    });
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        if (command.input.UpdateExpression) throw conditional;
        return {};
      },
    } as never;
    await expect(backfillArchiveRetryIndexPage(doc, tables)).resolves.toBe(false);
  });

  it("propagates an unexpected migration lease-claim failure", async () => {
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        if (command.input.UpdateExpression?.toString().includes("ADD fence")) {
          throw new Error("migration lease unavailable");
        }
        return {};
      },
    } as never;

    await expect(backfillArchiveRetryIndexPage(doc, tables)).rejects.toThrow(
      "migration lease unavailable",
    );
  });

  it("resumes a page, skips indexed and stored rows, and tolerates raced backfill", async () => {
    const conditional = Object.assign(new Error("row changed"), {
      name: "ConditionalCheckFailedException",
    });
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        calls.push(command);
        if (!command.input.UpdateExpression) {
          if (command.input.TableName === "SessionDrains") return {};
          return {
            Items: [
              { key: "stored", objectStored: true },
              { key: 42, objectStored: false },
              { key: "indexed", objectStored: false, retryState: "pending", retryOrder: "old" },
              { key: "raced", objectStored: false, updatedAt: "2026-01-01T00:00:00.000Z" },
              { key: "missing-time", objectStored: false },
            ],
            LastEvaluatedKey: { key: "next" },
          };
        }
        if (command.input.UpdateExpression.toString().includes("ADD fence")) {
          return { Attributes: { fence: 2, nextKey: { key: "previous" } } };
        }
        if (command.input.TableName === "Archives") throw conditional;
        return {};
      },
    } as never;
    await expect(backfillArchiveRetryIndexPage(doc, tables)).resolves.toBe(false);
    const scan = calls.find((call) => call.input.TableName === "Archives");
    expect(scan?.input).toMatchObject({ ExclusiveStartKey: { key: "previous" } });
  });

  it("propagates a non-conditional row update failure", async () => {
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        if (command.input.UpdateExpression?.toString().includes("ADD fence")) {
          return { Attributes: { fence: 1 } };
        }
        if (command.input.TableName === "Archives" && command.input.ConsistentRead) {
          return { Items: [{ key: "broken", objectStored: false }] };
        }
        if (command.input.TableName === "Archives") throw new Error("archive write failed");
        return {};
      },
    } as never;
    await expect(backfillArchiveRetryIndexPage(doc, tables)).rejects.toThrow(
      "archive write failed",
    );
  });
});
