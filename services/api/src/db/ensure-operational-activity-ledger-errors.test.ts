import { describe, expect, it } from "vitest";

import { migrateOperationalActivityLedgerPage } from "./ensure-operational-activity-ledger.ts";

const tables = { sessions: "Sessions", sessionDrains: "SessionDrains" };
const conditional = Object.assign(new Error("lost race"), {
  name: "ConditionalCheckFailedException",
});
const cancelled = Object.assign(new Error("lost fence"), {
  name: "TransactionCanceledException",
  CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
});

describe("operational activity migration fences", () => {
  it("short circuits when the ready marker already exists", async () => {
    let calls = 0;
    await expect(
      migrateOperationalActivityLedgerPage(
        {
          send: async () => {
            calls += 1;
            return { Item: { recordType: "operational-activity-ready-v2" } };
          },
        } as never,
        tables,
      ),
    ).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("propagates an infrastructure failure while claiming the migration lease", async () => {
    const unavailable = new Error("Dynamo unavailable");
    let calls = 0;
    await expect(
      migrateOperationalActivityLedgerPage(
        {
          send: async () => {
            calls += 1;
            if (calls === 1) return {};
            throw unavailable;
          },
        } as never,
        tables,
      ),
    ).rejects.toBe(unavailable);
    expect(calls).toBe(2);
  });

  it("ignores a raced terminal timestamp repair and still publishes readiness", async () => {
    const commands: string[] = [];
    const doc = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        commands.push(command.constructor.name);
        if (command.input.Key?.recordKey === "READY") return {};
        if (String(command.input.UpdateExpression).includes("ADD fence"))
          return { Attributes: { fence: 1 } };
        if (command.constructor.name === "ScanCommand")
          return {
            Items: [
              {
                id: "terminal",
                repositoryId: "repo",
                queueShard: 0,
                status: "completed",
                createdAt: "2026-01-01",
              },
            ],
          };
        if (command.input.UpdateExpression === "SET completedAt = :completedAt") throw conditional;
        return {};
      },
    } as never;
    await expect(migrateOperationalActivityLedgerPage(doc, tables)).resolves.toBe(true);
    expect(commands).toContain("TransactWriteCommand");
  });

  it("does not swallow a failed terminal timestamp write", async () => {
    const unavailable = new Error("write unavailable");
    const doc = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.input.Key?.recordKey === "READY") return {};
        if (String(command.input.UpdateExpression).includes("ADD fence"))
          return { Attributes: { fence: 1 } };
        if (command.constructor.name === "ScanCommand")
          return {
            Items: [
              {
                id: "terminal",
                repositoryId: "repo",
                queueShard: 0,
                status: "completed",
                createdAt: "2026-01-01",
              },
            ],
          };
        throw unavailable;
      },
    } as never;
    await expect(migrateOperationalActivityLedgerPage(doc, tables)).rejects.toBe(unavailable);
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    "rechecks readiness after a lost finalizer fence (published=%s)",
    async (published, expected) => {
      let calls = 0;
      const doc = {
        send: async () => {
          calls += 1;
          if (calls === 1) return {};
          if (calls === 2) return { Attributes: { fence: 1 } };
          if (calls === 3) return {};
          if (calls === 4) throw cancelled;
          return published ? { Item: { recordType: "operational-activity-ready-v2" } } : {};
        },
      } as never;
      await expect(migrateOperationalActivityLedgerPage(doc, tables)).resolves.toBe(expected);
      expect(calls).toBe(5);
    },
  );

  it("propagates a nonconditional finalizer failure", async () => {
    const unavailable = new Error("transaction unavailable");
    let calls = 0;
    const doc = {
      send: async () => {
        calls += 1;
        if (calls === 1) return {};
        if (calls === 2) return { Attributes: { fence: 1 } };
        if (calls === 3) return { Items: [] };
        throw unavailable;
      },
    } as never;
    await expect(migrateOperationalActivityLedgerPage(doc, tables)).rejects.toBe(unavailable);
  });
});
