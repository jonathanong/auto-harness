import {
  DescribeTimeToLiveCommand,
  type DynamoDBClient,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import { enableRateLimitTtl, enableTableTtl } from "./ensure-rate-limit-table.ts";

function client(send: (command: unknown) => Promise<unknown>): DynamoDBClient {
  return { send } as DynamoDBClient;
}

describe("enableTableTtl", () => {
  it("skips the update when TTL is already enabled or enabling", async () => {
    const commands: unknown[] = [];
    await enableTableTtl(
      client(async (command) => {
        commands.push(command);
        return { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" } };
      }),
      "SessionLogs",
      "ttl",
    );
    await enableTableTtl(
      client(async (command) => {
        commands.push(command);
        return { TimeToLiveDescription: { TimeToLiveStatus: "ENABLING" } };
      }),
      "SessionLogs",
      "ttl",
    );
    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command instanceof DescribeTimeToLiveCommand)).toBe(true);
  });

  it("enables TTL when it is currently disabled", async () => {
    const commands: unknown[] = [];
    await enableTableTtl(
      client(async (command) => {
        commands.push(command);
        return { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } };
      }),
      "SessionLogs",
      "ttl",
    );
    expect(commands[0]).toBeInstanceOf(DescribeTimeToLiveCommand);
    expect(commands[1]).toBeInstanceOf(UpdateTimeToLiveCommand);
    expect((commands[1] as UpdateTimeToLiveCommand).input).toMatchObject({
      TableName: "SessionLogs",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("treats a concurrent already-enabled response as success", async () => {
    await expect(
      enableTableTtl(
        client(async (command) => {
          if (command instanceof DescribeTimeToLiveCommand) {
            return { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } };
          }
          const error = new Error("TimeToLive is already enabled");
          error.name = "ValidationException";
          throw error;
        }),
        "RateLimits",
        "expiresAt",
      ),
    ).resolves.toBeUndefined();
  });

  it("propagates unrelated enable failures", async () => {
    await expect(
      enableTableTtl(
        client(async (command) => {
          if (command instanceof DescribeTimeToLiveCommand) {
            return { TimeToLiveDescription: {} };
          }
          throw new Error("throttled");
        }),
        "SessionLogs",
        "ttl",
      ),
    ).rejects.toThrow("throttled");
    await expect(
      enableTableTtl(
        client(async (command) => {
          if (command instanceof DescribeTimeToLiveCommand) {
            return { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } };
          }
          const error = new Error("requested resource not found");
          error.name = "ValidationException";
          throw error;
        }),
        "SessionLogs",
        "ttl",
      ),
    ).rejects.toThrow("requested resource not found");
  });

  it("enables the rate-limit table on expiresAt", async () => {
    let update: UpdateTimeToLiveCommand["input"] | undefined;
    await enableRateLimitTtl(
      client(async (command) => {
        if (command instanceof UpdateTimeToLiveCommand) update = command.input;
        return { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } };
      }),
      "RateLimits",
    );
    expect(update).toMatchObject({
      TableName: "RateLimits",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });
});
