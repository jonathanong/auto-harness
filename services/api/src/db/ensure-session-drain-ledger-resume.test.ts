import { describe, expect, it } from "vitest";

import { migrateSessionDrainActivityLedgerPage } from "./ensure-session-drain-ledger.ts";

const tables = { sessions: "Sessions", sessionDrains: "SessionDrains" };

describe("session drain activity-ledger migration resume", () => {
  it("checkpoints one bounded page and resumes from its durable cursor", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    let invocation = 0;
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        calls.push(command);
        if (command.input.Key?.recordKey === "ACTIVITY-V1") return {};
        if (command.input.UpdateExpression?.toString().includes("ADD fence")) {
          invocation += 1;
          return invocation === 1
            ? { Attributes: { fence: 1 } }
            : { Attributes: { fence: 2, nextKey: { id: "page-one" } } };
        }
        if (command.input.TableName === "Sessions") {
          return invocation === 1
            ? { Items: [], LastEvaluatedKey: { id: "page-one" } }
            : { Items: [] };
        }
        return {};
      },
    } as never;

    await expect(migrateSessionDrainActivityLedgerPage(doc, tables)).resolves.toBe(false);
    await expect(migrateSessionDrainActivityLedgerPage(doc, tables)).resolves.toBe(true);

    const scans = calls.filter((call) => call.input.TableName === "Sessions");
    expect(scans).toHaveLength(2);
    expect(scans[0]?.input).toMatchObject({ Limit: 100 });
    expect(scans[1]?.input).toMatchObject({
      Limit: 100,
      ExclusiveStartKey: { id: "page-one" },
    });
    expect(calls).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          UpdateExpression: "SET nextKey = :nextKey REMOVE leaseOwner, leaseUntil",
          ConditionExpression: "leaseOwner = :owner AND fence = :fence",
        }),
      }),
    );
  });

  it("does no scan while another fenced migration worker owns the page", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const error = Object.assign(new Error("busy"), {
      name: "ConditionalCheckFailedException",
    });
    await expect(
      migrateSessionDrainActivityLedgerPage(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            calls.push(command);
            if (command.input.Key?.recordKey === "ACTIVITY-V1") return {};
            throw error;
          },
        } as never,
        tables,
      ),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.input.TableName === "Sessions")).toBe(false);
  });

  it("propagates a non-conditional migration lease failure", async () => {
    const unavailable = new Error("migration table unavailable");
    await expect(
      migrateSessionDrainActivityLedgerPage(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            if (command.input.Key?.recordKey === "ACTIVITY-V1") return {};
            throw unavailable;
          },
        } as never,
        tables,
      ),
    ).rejects.toBe(unavailable);
  });

  it("reports incomplete when a stale finalizer loses its fence before READY", async () => {
    let calls = 0;
    const transactionError = Object.assign(new Error("lost fence"), {
      name: "TransactionCanceledException",
    });
    await expect(
      migrateSessionDrainActivityLedgerPage(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            calls += 1;
            if (calls === 1) return {};
            if (calls === 2) return { Attributes: { fence: 1 } };
            if (calls === 3) return { Items: [] };
            if (calls === 4) throw transactionError;
            expect(command.input.Key).toEqual({
              scopeKey: "__session-drain-ledger__",
              recordKey: "ACTIVITY-V1",
            });
            return {};
          },
        } as never,
        tables,
      ),
    ).resolves.toBe(false);
  });
});
