import { DescribeTableCommand, ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import { ensureSessionsActiveHostIndex } from "./ensure-active-host-index.ts";

describe("ensureSessionsActiveHostIndex", () => {
  it("accepts only an active sparse host-claim index", async () => {
    const client = {
      send: async (command: unknown) => {
        expect(command).toBeInstanceOf(DescribeTableCommand);
        return {
          Table: {
            TableStatus: "ACTIVE",
            GlobalSecondaryIndexes: [
              { IndexName: "activeHostId-activeHostOrder", IndexStatus: "ACTIVE" },
            ],
          },
        };
      },
    } as never;

    await expect(ensureSessionsActiveHostIndex(client, "Sessions")).resolves.toBeUndefined();
  });

  it("rejects an active legacy table without the index", async () => {
    const client = {
      send: async (command: unknown) => {
        expect(command).toBeInstanceOf(DescribeTableCommand);
        return { Table: { TableStatus: "ACTIVE", GlobalSecondaryIndexes: [] } };
      },
    } as never;

    await expect(ensureSessionsActiveHostIndex(client, "Sessions")).rejects.toThrow(
      /deploy a fresh environment/,
    );
  });

  it("waits for a newly-created table and index", async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        return {
          Table: {
            TableStatus: calls === 1 ? "CREATING" : "ACTIVE",
            GlobalSecondaryIndexes: [
              {
                IndexName: "activeHostId-activeHostOrder",
                IndexStatus: calls === 1 ? "CREATING" : "ACTIVE",
              },
            ],
          },
        };
      },
    } as never;

    await expect(
      ensureSessionsActiveHostIndex(client, "Sessions", { attempts: 2, retryMs: 0 }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("reports bounded readiness exhaustion after a missing table", async () => {
    const client = {
      send: async () => {
        throw new ResourceNotFoundException({ $metadata: {}, message: "missing" });
      },
    } as never;

    await expect(
      ensureSessionsActiveHostIndex(client, "Sessions", { attempts: 1, retryMs: 0 }),
    ).rejects.toThrow("did not become active");
  });

  it("retries a missing table and preserves unrelated failures", async () => {
    let calls = 0;
    const recovering = {
      send: async () => {
        calls++;
        if (calls === 1) {
          throw new ResourceNotFoundException({ $metadata: {}, message: "missing" });
        }
        return {
          Table: {
            TableStatus: "ACTIVE",
            GlobalSecondaryIndexes: [
              { IndexName: "activeHostId-activeHostOrder", IndexStatus: "ACTIVE" },
            ],
          },
        };
      },
    } as never;
    await expect(
      ensureSessionsActiveHostIndex(recovering, "Sessions", { attempts: 2, retryMs: 0 }),
    ).resolves.toBeUndefined();

    const failure = new Error("access denied");
    const failing = { send: async () => Promise.reject(failure) } as never;
    await expect(
      ensureSessionsActiveHostIndex(failing, "Sessions", { attempts: 2, retryMs: 0 }),
    ).rejects.toBe(failure);
  });

  it("reports bounded readiness exhaustion while the index is creating", async () => {
    const client = {
      send: async () => ({
        Table: {
          TableStatus: "CREATING",
          GlobalSecondaryIndexes: [
            { IndexName: "activeHostId-activeHostOrder", IndexStatus: "CREATING" },
          ],
        },
      }),
    } as never;

    await expect(
      ensureSessionsActiveHostIndex(client, "Sessions", { attempts: 1, retryMs: 0 }),
    ).rejects.toThrow("did not become active");
  });
});
