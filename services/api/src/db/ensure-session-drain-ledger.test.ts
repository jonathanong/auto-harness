/* eslint-disable max-lines -- migration coverage cases share one fixture. */
import { describe, expect, it, vi } from "vitest";

import { migrateSessionDrainActivityLedgerPage } from "./ensure-session-drain-ledger.ts";

describe("session drain activity-ledger bootstrap", () => {
  it("backs up active metadata-owned sessions before conditionally publishing readiness", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        calls.push(command);
        if (command.input.Key?.recordKey === "ACTIVITY-V1") return {};
        if (command.input.TableName === "Sessions") {
          return {
            Items: [
              {
                id: "queued",
                repositoryId: "repo",
                metadata: { createdBy: "legacy-principal" },
                status: "queued",
              },
              {
                id: "terminal",
                repositoryId: "repo",
                principalId: "principal",
                status: "completed",
              },
              {
                id: "running",
                repositoryId: "repo",
                principalId: "principal",
                status: "running",
              },
              {
                id: "cancelled-with-worktree",
                repositoryId: "repo",
                principalId: "principal",
                status: "cancelled",
                worktreeId: "worktree",
              },
            ],
          };
        }
        return {};
      },
    } as never;

    await migrateSessionDrainActivityLedgerPage(doc, {
      sessions: "Sessions",
      sessionDrains: "SessionDrains",
    });

    expect(calls.map((call) => call.input.TableName)).toEqual([
      "SessionDrains",
      "SessionDrains",
      "Sessions",
      undefined,
      undefined,
    ]);
    expect(calls[2]?.input).toMatchObject({ ConsistentRead: true, Limit: 100 });
    expect(calls[3]?.input).toMatchObject({
      RequestItems: {
        SessionDrains: [
          {
            PutRequest: {
              Item: {
                scopeKey: "repo#legacy-principal",
                recordKey: "ACT#queued",
                sessionId: "queued",
              },
            },
          },
          {
            PutRequest: {
              Item: {
                scopeKey: "repo#principal",
                recordKey: "ACT#running",
                sessionId: "running",
              },
            },
          },
          {
            PutRequest: {
              Item: {
                scopeKey: "repo#principal",
                recordKey: "ACT#cancelled-with-worktree",
                sessionId: "cancelled-with-worktree",
              },
            },
          },
        ],
      },
    });
    expect(calls[4]?.input).toMatchObject({
      TransactItems: expect.arrayContaining([
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              scopeKey: "__session-drain-ledger__",
              recordKey: "ACTIVITY-V1",
            }),
          }),
        }),
      ]),
    });
  });

  it("uses one strong ready read after bootstrap", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    await migrateSessionDrainActivityLedgerPage(
      {
        send: async (command: { input: Record<string, unknown> }) => {
          calls.push(command);
          return { Item: { recordType: "activity-ledger-v1" } };
        },
      } as never,
      { sessions: "Sessions", sessionDrains: "SessionDrains" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({
      TableName: "SessionDrains",
      ConsistentRead: true,
      Key: { scopeKey: "__session-drain-ledger__", recordKey: "ACTIVITY-V1" },
    });
  });

  it("backs off before retrying unprocessed activity writes", async () => {
    let batchWrites = 0;
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        if (command.input.Key?.recordKey === "ACTIVITY-V1") return {};
        if (command.input.TableName === "Sessions") {
          return {
            Items: [
              { id: "queued", repositoryId: "repo", principalId: "principal", status: "queued" },
            ],
          };
        }
        if (command.input.RequestItems) {
          batchWrites += 1;
          return batchWrites === 1
            ? { UnprocessedItems: command.input.RequestItems }
            : { UnprocessedItems: {} };
        }
        return {};
      },
    } as never;

    await migrateSessionDrainActivityLedgerPage(doc, {
      sessions: "Sessions",
      sessionDrains: "SessionDrains",
    });
    expect(batchWrites).toBe(2);
  });

  it("fails closed after bounded unprocessed-write retries", async () => {
    vi.useFakeTimers();
    try {
      let batchWrites = 0;
      const promise = migrateSessionDrainActivityLedgerPage(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            if (command.input.Key?.recordKey === "ACTIVITY-V1") return {};
            if (command.input.TableName === "Sessions") {
              return {
                Items: [
                  {
                    id: "queued",
                    repositoryId: "repo",
                    principalId: "principal",
                    status: "queued",
                  },
                ],
              };
            }
            if (command.input.RequestItems) {
              batchWrites += 1;
              return { UnprocessedItems: command.input.RequestItems };
            }
            return {};
          },
        } as never,
        { sessions: "Sessions", sessionDrains: "SessionDrains" },
      );
      const rejection = expect(promise).rejects.toThrow(
        "could not backfill the session drain activity ledger",
      );
      await vi.runAllTimersAsync();
      await rejection;
      expect(batchWrites).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginates sparse scans and accepts a concurrent readiness publisher", async () => {
    let scans = 0;
    let claims = 0;
    let readyReads = 0;
    const conditional = Object.assign(new Error("published"), {
      name: "ConditionalCheckFailedException",
    });
    const calls: Array<Record<string, unknown>> = [];
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        calls.push(command.input);
        if (command.input.Key?.recordKey === "ACTIVITY-V1") {
          readyReads += 1;
          return readyReads === 3 ? { Item: { recordType: "activity-ledger-v1" } } : {};
        }
        if (String(command.input.UpdateExpression).startsWith("SET recordType")) {
          claims += 1;
          return {
            Attributes: {
              fence: claims,
              ...(claims === 2 ? { nextKey: { id: "cancelled-main" } } : {}),
            },
          };
        }
        if (command.input.TableName === "Sessions") {
          scans += 1;
          return scans === 1
            ? {
                Items: [
                  {
                    id: "cancelled-main",
                    repositoryId: "repo",
                    principalId: "principal",
                    status: "cancelled",
                    mainCheckoutLease: true,
                  },
                ],
                LastEvaluatedKey: { id: "cancelled-main" },
              }
            : {};
        }
        if (command.input.RequestItems || command.input.UpdateExpression) return {};
        throw conditional;
      },
    } as never;
    const tables = { sessions: "Sessions", sessionDrains: "SessionDrains" };

    await expect(migrateSessionDrainActivityLedgerPage(doc, tables)).resolves.toBe(false);
    await expect(migrateSessionDrainActivityLedgerPage(doc, tables)).resolves.toBe(true);
    expect(scans).toBe(2);
    expect(calls.find((call) => call.ExclusiveStartKey)).toMatchObject({
      ExclusiveStartKey: { id: "cancelled-main" },
    });
  });
});
