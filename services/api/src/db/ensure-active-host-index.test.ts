import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import { ensureSessionsActiveHostIndex } from "./ensure-active-host-index.ts";

describe("ensureSessionsActiveHostIndex", () => {
  it("accepts only an active sparse host-claim index", async () => {
    const client = {
      send: async (command: unknown) => {
        expect(command).toBeInstanceOf(DescribeTableCommand);
        return {
          Table: {
            GlobalSecondaryIndexes: [
              { IndexName: "activeHostId-activeHostOrder", IndexStatus: "ACTIVE" },
            ],
          },
        };
      },
    } as never;

    await expect(ensureSessionsActiveHostIndex(client, "Sessions")).resolves.toBeUndefined();
  });

  it.each([undefined, "CREATING"])("rejects an unsafe index state %s", async (status) => {
    const client = {
      send: async (command: unknown) => {
        expect(command).toBeInstanceOf(DescribeTableCommand);
        return {
          Table: {
            GlobalSecondaryIndexes:
              status === undefined
                ? []
                : [{ IndexName: "activeHostId-activeHostOrder", IndexStatus: status }],
          },
        };
      },
    } as never;

    await expect(ensureSessionsActiveHostIndex(client, "Sessions")).rejects.toThrow(
      /deploy a fresh environment/,
    );
  });
});
