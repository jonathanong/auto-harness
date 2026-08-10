import { describe, expect, it } from "vitest";

import { describeControlPlane, DYNAMO_TABLES, getServiceName, statusShardKey } from "./index.ts";

describe("CDK table catalog", () => {
  it("matches the current durable storage names and keys", () => {
    expect(DYNAMO_TABLES.map((table) => table.name)).toEqual([
      "Users",
      "Repositories",
      "Worktrees",
      "Sessions",
      "HostLocks",
      "ConcurrencyLocks",
      "SessionLogs",
      "Schedules",
      "Connections",
      "Archives",
      "HostInventories",
      "AuditLogs",
      "Providers",
      "ProviderAccounts",
      "Commands",
    ]);
    expect(DYNAMO_TABLES.find((table) => table.name === "Worktrees")?.gsis).toEqual([
      {
        name: "repositoryId-id",
        partitionKey: { name: "repositoryId", type: "S" },
        sortKey: { name: "id", type: "S" },
      },
    ]);
    expect(DYNAMO_TABLES.find((table) => table.name === "SessionLogs")).toMatchObject({
      sortKey: { name: "timestampSeq" },
      ttlAttribute: "ttl",
    });
    expect(DYNAMO_TABLES.find((table) => table.name === "AuditLogs")).toMatchObject({
      partitionKey: { name: "scope" },
      sortKey: { name: "timestampId" },
    });
    const sessions = DYNAMO_TABLES.find((t) => t.name === "Sessions");
    expect(sessions?.gsis?.some((g) => g.name === "statusShard-createdAt")).toBe(true);
    expect(sessions?.gsis?.some((g) => g.name === "repositoryId-createdAt")).toBe(true);
    const connections = DYNAMO_TABLES.find((t) => t.name === "Connections");
    expect(connections?.gsis?.some((g) => g.name === "hostId")).toBe(true);
    expect(statusShardKey("queued", 2)).toBe("queued#2");
    expect(describeControlPlane().tables).toBe(DYNAMO_TABLES);
    expect(getServiceName()).toBe("@auto-harness/cdk");
  });
});
