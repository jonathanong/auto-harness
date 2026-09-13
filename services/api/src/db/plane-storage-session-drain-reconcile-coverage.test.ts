import { describe, expect, it } from "vitest";

import { listSessionDrainReconcileCandidates } from "./plane-storage-session-drains.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function context(send: (command: { input: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send },
    tables: { sessionDrains: "SessionDrains" },
  } as unknown as PlaneStorageCtx;
}

describe("session drain reconciler cursor", () => {
  it("persists the fourth-page continuation when no drain is eligible", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    let scans = 0;
    const storage = context(async (command) => {
      commands.push(command);
      if (command.input.Key?.recordKey === "CURSOR-V1") return {};
      if (command.input.Limit === 50) {
        scans += 1;
        return {
          Items: [{ scopeKey: `repo-${scans}`, recordKey: "CURRENT", status: "released" }],
          LastEvaluatedKey: { scopeKey: `next-${scans}`, recordKey: "CURRENT" },
        };
      }
      return {};
    });

    await expect(listSessionDrainReconcileCandidates(storage)).resolves.toEqual([]);
    expect(scans).toBe(4);
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: {
          TableName: "SessionDrains",
          Item: expect.objectContaining({
            nextKey: { scopeKey: "next-4", recordKey: "CURRENT" },
          }),
        },
      }),
    );
  });

  it("starts at the beginning when no durable cursor exists", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const storage = context(async (command) => {
      commands.push(command);
      if (command.input.Key?.recordKey === "CURSOR-V1") return {};
      if (command.input.Limit === 50) {
        return {
          Items: [{ scopeKey: "repo#owner", recordKey: "CURRENT", status: "draining" }],
        };
      }
      return {};
    });

    await expect(listSessionDrainReconcileCandidates(storage, 2)).resolves.toEqual([
      { scopeKey: "repo#owner", recordKey: "CURRENT", status: "draining" },
    ]);
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: { TableName: "SessionDrains", Limit: 50 },
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: {
          TableName: "SessionDrains",
          Key: { scopeKey: "__session-drain-reconciler__", recordKey: "CURSOR-V1" },
        },
      }),
    );
  });

  it("skips non-draining rows across pages and removes an exhausted cursor", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    let scans = 0;
    const storage = context(async (command) => {
      commands.push(command);
      if (command.input.Key?.recordKey === "CURSOR-V1") {
        return { Item: { nextKey: { scopeKey: "previous", recordKey: "CURRENT" } } };
      }
      if (command.input.Limit === 50) {
        scans += 1;
        return scans === 1
          ? {
              Items: [
                { scopeKey: "repo-a#owner", recordKey: "ACT#old", status: "draining" },
                { scopeKey: "repo-a#owner", recordKey: "CURRENT", status: "released" },
              ],
              LastEvaluatedKey: { scopeKey: "repo-b#owner", recordKey: "CURRENT" },
            }
          : {
              Items: [
                { scopeKey: "repo-b#owner", recordKey: "CURRENT", status: "draining" },
                { scopeKey: "repo-c#owner", recordKey: "CURRENT", status: "draining" },
              ],
            };
      }
      return {};
    });

    await expect(listSessionDrainReconcileCandidates(storage, 3)).resolves.toEqual([
      { scopeKey: "repo-b#owner", recordKey: "CURRENT", status: "draining" },
      { scopeKey: "repo-c#owner", recordKey: "CURRENT", status: "draining" },
    ]);
    expect(scans).toBe(2);
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          ExclusiveStartKey: { scopeKey: "previous", recordKey: "CURRENT" },
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          ExclusiveStartKey: { scopeKey: "repo-b#owner", recordKey: "CURRENT" },
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        input: {
          TableName: "SessionDrains",
          Key: { scopeKey: "__session-drain-reconciler__", recordKey: "CURSOR-V1" },
        },
      }),
    );
  });
});
