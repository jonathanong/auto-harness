import { describe, expect, it } from "vitest";

import { migrateOperationalActivityLedgerPage } from "./ensure-operational-activity-ledger.ts";

const tables = { sessions: "Sessions", sessionDrains: "SessionDrains" };

describe("operational activity ledger migration", () => {
  it("backfills one strong bounded page, repairs legacy terminal timestamps, and resumes", async () => {
    const calls: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    let invocation = 0;
    const doc = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push(command);
        if (command.input.Key?.recordKey === "READY") return {};
        if (String(command.input.UpdateExpression).includes("ADD fence")) {
          invocation += 1;
          return invocation === 1
            ? { Attributes: { fence: 1 } }
            : { Attributes: { fence: 2, nextKey: { id: "page-one" } } };
        }
        if (command.constructor.name === "ScanCommand")
          return invocation === 1
            ? {
                Items: [
                  {
                    id: "queued",
                    repositoryId: "repo",
                    status: "queued",
                    queueShard: 0,
                    createdAt: "2026-01-01",
                  },
                  {
                    id: "terminal",
                    repositoryId: "repo",
                    status: "completed",
                    queueShard: 0,
                    createdAt: "2026-01-01",
                  },
                ],
                LastEvaluatedKey: { id: "page-one" },
              }
            : { Items: [] };
        return {};
      },
    } as never;

    await expect(migrateOperationalActivityLedgerPage(doc, tables)).resolves.toBe(false);
    await expect(migrateOperationalActivityLedgerPage(doc, tables)).resolves.toBe(true);
    const scans = calls.filter((call) => call.constructor.name === "ScanCommand");
    expect(scans).toHaveLength(2);
    expect(scans[0]?.input).toMatchObject({ ConsistentRead: true, Limit: 25 });
    expect(scans[1]?.input).toMatchObject({ ExclusiveStartKey: { id: "page-one" } });
    expect(
      calls.find((call) => call.input.UpdateExpression === "SET completedAt = :completedAt")?.input,
    ).toMatchObject({
      ConditionExpression:
        "createdAt = :createdAt AND #status = :status AND attribute_not_exists(completedAt)",
    });
    expect(
      calls.find((call) => call.constructor.name === "BatchWriteCommand")?.input,
    ).toMatchObject({
      RequestItems: {
        SessionDrains: [
          { PutRequest: { Item: { scopeKey: "__repo#v2#repo", recordKey: "ACT#queued" } } },
        ],
      },
    });
    expect(calls.some((call) => call.constructor.name === "TransactWriteCommand")).toBe(true);
  });

  it("does not scan while another migration worker holds the lease", async () => {
    const calls: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    const busy = Object.assign(new Error("busy"), { name: "ConditionalCheckFailedException" });
    const doc = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push(command);
        if (command.input.Key?.recordKey === "READY") return {};
        throw busy;
      },
    } as never;
    await expect(migrateOperationalActivityLedgerPage(doc, tables)).resolves.toBe(false);
    expect(calls.map((call) => call.constructor.name)).toEqual(["GetCommand", "UpdateCommand"]);
  });

  it("leaves readiness unpublished if activity batch writes stay unprocessed", async () => {
    const calls: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    const doc = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push(command);
        if (command.input.Key?.recordKey === "READY") return {};
        if (String(command.input.UpdateExpression).includes("ADD fence"))
          return { Attributes: { fence: 1 } };
        if (command.constructor.name === "ScanCommand")
          return {
            Items: [
              {
                id: "queued",
                repositoryId: "repo",
                status: "queued",
                queueShard: 0,
                createdAt: "2026-01-01",
              },
            ],
          };
        if (command.constructor.name === "BatchWriteCommand")
          return { UnprocessedItems: command.input.RequestItems };
        return {};
      },
    } as never;
    await expect(migrateOperationalActivityLedgerPage(doc, tables)).rejects.toThrow(
      "could not backfill",
    );
    expect(calls.filter((call) => call.constructor.name === "BatchWriteCommand")).toHaveLength(5);
    expect(calls.some((call) => call.constructor.name === "TransactWriteCommand")).toBe(false);
  });
});
