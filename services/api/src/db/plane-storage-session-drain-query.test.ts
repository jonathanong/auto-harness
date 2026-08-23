import { describe, expect, it } from "vitest";

import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import {
  listSessionDrainActivityPage,
  listSessionDrainReconcileCandidates,
} from "./plane-storage-session-drains.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function context(send: (command: { input: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send },
    tables: { sessions: "Sessions", sessionDrains: "SessionDrains" },
  } as unknown as PlaneStorageCtx;
}

describe("DynamoDB session drain activity ledger", () => {
  it("strongly queries only the principal ACT partition", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const ctx = context(async (command) => {
      commands.push(command);
      return { Items: [{ recordKey: "ACT#owned", sessionId: "owned" }] };
    });

    await expect(listSessionDrainActivityPage(ctx, "repo", "principal")).resolves.toMatchObject({
      records: [{ recordKey: "ACT#owned", sessionId: "owned" }],
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toMatchObject({
      TableName: "SessionDrains",
      ConsistentRead: true,
      KeyConditionExpression: "scopeKey = :scopeKey AND begins_with(recordKey, :activityPrefix)",
      ExpressionAttributeValues: {
        ":scopeKey": "repo#principal",
        ":activityPrefix": "ACT#",
      },
    });
  });

  it("pages the bounded scope without consulting any Sessions index", async () => {
    let page = 0;
    const ctx = context(async (command) => {
      expect(command.input.ExclusiveStartKey).toEqual(page === 0 ? undefined : { id: "first" });
      page += 1;
      return page === 1
        ? {
            Items: [{ recordKey: "ACT#first", sessionId: "first" }],
            LastEvaluatedKey: { id: "first" },
          }
        : { Items: [{ recordKey: "ACT#second", sessionId: "second" }] };
    });

    await expect(listSessionDrainActivityPage(ctx, "repo", "principal")).resolves.toMatchObject({
      records: [{ sessionId: "first" }],
      nextKey: { id: "first" },
    });
    expect(page).toBe(1);
  });

  it("hydrates exact sessions strongly and deletes only terminal activity members", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const storage = new DynamoPlaneStorageBase(
      {
        send: async (command: { input: Record<string, unknown> }) => {
          commands.push(command);
          if (command.input.TableName === "SessionDrains" && command.input.KeyConditionExpression) {
            return {
              Items: [
                {
                  scopeKey: "repo#principal",
                  recordKey: "ACT#queued",
                  recordType: "activity",
                  sessionId: "queued",
                  repositoryId: "repo",
                  principalId: "principal",
                },
                {
                  scopeKey: "repo#principal",
                  recordKey: "ACT#done",
                  recordType: "activity",
                  sessionId: "done",
                  repositoryId: "repo",
                  principalId: "principal",
                },
                {
                  scopeKey: "repo#principal",
                  recordKey: "ACT#legacy",
                  recordType: "activity",
                  sessionId: "legacy",
                  repositoryId: "repo",
                  principalId: "principal",
                },
              ],
            };
          }
          if (command.input.TableName === "Sessions") {
            if (command.input.Key?.id === "queued")
              return {
                Item: {
                  id: "queued",
                  repositoryId: "repo",
                  principalId: "principal",
                  status: "queued",
                },
              };
            return command.input.Key?.id === "legacy"
              ? {
                  Item: {
                    id: "legacy",
                    repositoryId: "repo",
                    metadata: { createdBy: "principal" },
                    status: "queued",
                  },
                }
              : {
                  Item: {
                    id: "done",
                    repositoryId: "repo",
                    principalId: "principal",
                    status: "completed",
                  },
                };
          }
          return {};
        },
      } as never,
      { sessions: "Sessions", sessionDrains: "SessionDrains" } as never,
    );

    await expect(
      storage.listSessionsForDrain("repo", "principal", "operation", 1),
    ).resolves.toMatchObject({ sessions: [{ id: "queued" }, { id: "done" }] });
    expect(
      commands
        .filter((command) => command.input.TableName === "Sessions")
        .map((command) => command.input),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ConsistentRead: true, Key: { id: "queued" } }),
        expect.objectContaining({ ConsistentRead: true, Key: { id: "done" } }),
      ]),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "SessionDrains",
          Key: { scopeKey: "repo#principal", recordKey: "ACT#done" },
        }),
      }),
    );
  });

  it("uses a bounded durable cursor to give later drains a turn", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    let scan = 0;
    const ctx = context(async (command) => {
      commands.push(command);
      if (
        command.input.TableName === "SessionDrains" &&
        command.input.Key?.recordKey === "CURSOR-V1"
      ) {
        return { Item: { nextKey: { scopeKey: "old", recordKey: "ACT#old" } } };
      }
      if (command.input.Limit === 50) {
        scan += 1;
        return {
          Items: [
            { scopeKey: "repo#principal", recordKey: "CURRENT", status: "draining" },
            { scopeKey: "repo#principal", recordKey: "ACT#member", recordType: "activity" },
          ],
          LastEvaluatedKey: { scopeKey: "next", recordKey: "ACT#next" },
        };
      }
      return {};
    });
    await expect(listSessionDrainReconcileCandidates(ctx, 1)).resolves.toMatchObject([
      { recordKey: "CURRENT", status: "draining" },
    ]);
    expect(scan).toBe(1);
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          ExclusiveStartKey: { scopeKey: "old", recordKey: "ACT#old" },
        }),
      }),
    );
  });
});
