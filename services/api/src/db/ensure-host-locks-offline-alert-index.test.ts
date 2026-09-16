import { describe, expect, it } from "vitest";

import {
  ensureHostLocksOfflineAlertIndex,
  HOST_LOCKS_OFFLINE_ALERT_INDEX,
} from "./ensure-host-locks-offline-alert-index.ts";

describe("ensureHostLocksOfflineAlertIndex", () => {
  it("ignores an unavailable table and an index that is already present", async () => {
    let calls = 0;
    await expect(
      ensureHostLocksOfflineAlertIndex(
        {
          send: async () => {
            calls += 1;
            return Promise.reject(new Error("table unavailable"));
          },
        } as never,
        "HostLocks",
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);

    await expect(
      ensureHostLocksOfflineAlertIndex(
        {
          send: async () => ({
            Table: { GlobalSecondaryIndexes: [{ IndexName: HOST_LOCKS_OFFLINE_ALERT_INDEX }] },
          }),
        } as never,
        "HostLocks",
      ),
    ).resolves.toBeUndefined();
  });

  it("adds the missing sparse-marker attribute and creates the index", async () => {
    const updates: Array<{ input: Record<string, unknown> }> = [];
    await expect(
      ensureHostLocksOfflineAlertIndex(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            if (command.input.AttributeDefinitions === undefined) {
              return {
                Table: { AttributeDefinitions: [{ AttributeName: "hostId", AttributeType: "S" }] },
              };
            }
            updates.push(command);
            return {};
          },
        } as never,
        "HostLocks",
      ),
    ).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.input.AttributeDefinitions).toEqual([
      { AttributeName: "hostId", AttributeType: "S" },
      { AttributeName: "offlineAlertPending", AttributeType: "S" },
    ]);
    const globalSecondaryIndexUpdates = updates[0]?.input.GlobalSecondaryIndexUpdates as Array<{
      Create: { IndexName: string };
    }>;
    expect(globalSecondaryIndexUpdates[0]?.Create.IndexName).toBe(HOST_LOCKS_OFFLINE_ALERT_INDEX);
  });

  it("reuses an already-declared attribute definition instead of duplicating it", async () => {
    const updates: Array<{ input: Record<string, unknown> }> = [];
    await expect(
      ensureHostLocksOfflineAlertIndex(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            if (command.input.AttributeDefinitions === undefined) {
              return {
                Table: {
                  AttributeDefinitions: [
                    { AttributeName: "hostId", AttributeType: "S" },
                    { AttributeName: "offlineAlertPending", AttributeType: "S" },
                  ],
                },
              };
            }
            updates.push(command);
            return {};
          },
        } as never,
        "HostLocks",
      ),
    ).resolves.toBeUndefined();
    expect(updates[0]?.input.AttributeDefinitions).toEqual([
      { AttributeName: "hostId", AttributeType: "S" },
      { AttributeName: "offlineAlertPending", AttributeType: "S" },
    ]);
  });

  it("tolerates an in-flight index update but rethrows an unexpected failure", async () => {
    await expect(
      ensureHostLocksOfflineAlertIndex(
        {
          send: async (command: { input: Record<string, unknown> }) => {
            if (command.input.AttributeDefinitions === undefined) return { Table: {} };
            throw Object.assign(new Error("update in progress"), {
              name: "LimitExceededException",
            });
          },
        } as never,
        "HostLocks",
      ),
    ).resolves.toBeUndefined();

    await expect(
      ensureHostLocksOfflineAlertIndex(
        {
          send: async (command: { input: Record<string, unknown> }) =>
            command.input.AttributeDefinitions === undefined
              ? { Table: {} }
              : Promise.reject(new Error("permission denied")),
        } as never,
        "HostLocks",
      ),
    ).rejects.toThrow("permission denied");
  });
});
