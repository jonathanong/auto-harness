import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { listActiveSessionsByHost } from "./plane-storage-sessions-active-host.ts";

describe("listActiveSessionsByHost", () => {
  it("uses the sparse active-host index instead of scanning session history", async () => {
    const commands: QueryCommand[] = [];
    const ctx = {
      tables: { sessions: "Sessions", hostLocks: "HostLocks" },
      doc: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) {
            commands.push(command);
            return { Items: [{ id: "active" }] };
          }
          if (command instanceof GetCommand && command.input.TableName === "Sessions")
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
          return { Item: { hostId: "host-a", assignmentCount: 1 } };
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

  it("rejects an incomplete eventual index view and ignores stale ownership", async () => {
    let assignmentCount = 1;
    const ctx = {
      tables: { sessions: "Sessions", hostLocks: "HostLocks" },
      doc: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) return { Items: [{ id: "moved" }] };
          if (command instanceof GetCommand && command.input.TableName === "Sessions") {
            return {
              Item: {
                id: "moved",
                status: "running",
                activeHostId: "host-b",
                activeHostOrder: "now#moved",
              },
            };
          }
          return { Item: { hostId: "host-a", assignmentCount } };
        },
      },
    } as never;

    await expect(listActiveSessionsByHost(ctx, "host-a")).rejects.toThrow(
      "active host claim index did not converge for host-a",
    );
    assignmentCount = 0;
    await expect(listActiveSessionsByHost(ctx, "host-a")).resolves.toEqual([]);
  });

  it("retries a lagging index and returns the propagated claim", async () => {
    let queries = 0;
    const ctx = {
      tables: { sessions: "Sessions", hostLocks: "HostLocks" },
      doc: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) {
            queries++;
            return { Items: queries === 1 ? [] : [{ id: "active" }] };
          }
          if (command instanceof GetCommand && command.input.TableName === "Sessions") {
            return { Item: { id: "active", status: "running", activeHostId: "host-a" } };
          }
          return { Item: { hostId: "host-a", assignmentCount: 1 } };
        },
      },
    } as never;

    await expect(listActiveSessionsByHost(ctx, "host-a")).resolves.toMatchObject([
      { id: "active" },
    ]);
    expect(queries).toBe(2);
  });

  it("pages an empty sparse index view without scanning history", async () => {
    const queries: QueryCommand[] = [];
    const ctx = {
      tables: { sessions: "Sessions", hostLocks: "HostLocks" },
      doc: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) {
            queries.push(command);
            return queries.length === 1 ? { LastEvaluatedKey: { id: "cursor" } } : { Items: [] };
          }
          return { Item: { hostId: "host-a", assignmentCount: 0 } };
        },
      },
    } as never;

    await expect(listActiveSessionsByHost(ctx, "host-a")).resolves.toEqual([]);
    expect(queries).toHaveLength(2);
    expect(queries[1]?.input.ExclusiveStartKey).toEqual({ id: "cursor" });
  });
});
