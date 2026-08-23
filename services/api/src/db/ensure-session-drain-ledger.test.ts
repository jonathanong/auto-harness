import { describe, expect, it, vi } from "vitest";

import { ensureSessionDrainActivityLedger } from "./ensure-session-drain-ledger.ts";

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
            ],
          };
        }
        return {};
      },
    } as never;

    await ensureSessionDrainActivityLedger(doc, {
      sessions: "Sessions",
      sessionDrains: "SessionDrains",
    });

    expect(calls.map((call) => call.input.TableName)).toEqual([
      "SessionDrains",
      "Sessions",
      undefined,
      "SessionDrains",
    ]);
    expect(calls[1]?.input).toMatchObject({ ConsistentRead: true });
    expect(calls[2]?.input).toMatchObject({
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
        ],
      },
    });
    expect(calls[3]?.input).toMatchObject({
      Item: {
        scopeKey: "__session-drain-ledger__",
        recordKey: "ACTIVITY-V1",
      },
      ConditionExpression: "attribute_not_exists(scopeKey)",
    });
  });

  it("uses one strong ready read after bootstrap", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    await ensureSessionDrainActivityLedger(
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

    await ensureSessionDrainActivityLedger(doc, {
      sessions: "Sessions",
      sessionDrains: "SessionDrains",
    });
    expect(batchWrites).toBe(2);
  });

  it("fails closed after bounded unprocessed-write retries", async () => {
    vi.useFakeTimers();
    try {
      let batchWrites = 0;
      const promise = ensureSessionDrainActivityLedger(
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
});
