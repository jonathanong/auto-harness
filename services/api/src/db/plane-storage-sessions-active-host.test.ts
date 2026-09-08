import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { listActiveSessionsByHost } from "./plane-storage-sessions-active-host.ts";

describe("listActiveSessionsByHost", () => {
  it("uses the sparse active-host index instead of scanning session history", async () => {
    const commands: QueryCommand[] = [];
    const ctx = {
      tables: { sessions: "Sessions" },
      doc: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) {
            commands.push(command);
            return { Items: [{ id: "active" }] };
          }
          return {
            Item: {
              id: "active",
              repositoryId: "repo",
              prompt: "prompt",
              target: { kind: "command", commandId: "command" },
              fallbacks: [],
              targetDisplayNames: ["command"],
              queueTtlSeconds: 60,
              queueExpiresAt: "2026-01-01T00:01:00.000Z",
              timeout: 60,
              priority: 0,
              requiredLabels: [],
              status: "running",
              queueShard: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              hostId: "host-a",
              activeHostId: "host-a",
              activeHostOrder: "2026-01-01T00:00:00.000Z#active",
            },
          };
        },
      },
    } as never;

    await expect(listActiveSessionsByHost(ctx, "host-a")).resolves.toMatchObject([
      { id: "active", hostId: "host-a" },
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toMatchObject({
      TableName: "Sessions",
      IndexName: "activeHostId-activeHostOrder",
      KeyConditionExpression: "activeHostId = :hostId",
      ExpressionAttributeValues: { ":hostId": "host-a" },
      Limit: 25,
    });
  });
});
