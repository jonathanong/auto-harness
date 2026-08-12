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
      "RateLimits",
      "Providers",
      "ProviderAccounts",
      "Commands",
      "SessionUsage",
      "SessionUsageKinds",
      "Integrations",
      "NotificationDeliveries",
      "WebhookDeliveries",
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
    expect(DYNAMO_TABLES.find((table) => table.name === "RateLimits")).toMatchObject({
      partitionKey: { name: "bucketKey" },
      ttlAttribute: "expiresAt",
    });
    expect(DYNAMO_TABLES.find((table) => table.name === "SessionUsage")).toMatchObject({
      partitionKey: { name: "sessionId" },
      sortKey: { name: "usageKey" },
    });
    expect(DYNAMO_TABLES.find((table) => table.name === "Integrations")).toMatchObject({
      partitionKey: { name: "id" },
    });
    expect(DYNAMO_TABLES.find((table) => table.name === "NotificationDeliveries")).toMatchObject({
      partitionKey: { name: "id" },
      gsis: [
        {
          name: "status-nextAttemptAt",
          partitionKey: { name: "status" },
          sortKey: { name: "nextAttemptAt" },
        },
      ],
    });
    expect(DYNAMO_TABLES.find((table) => table.name === "WebhookDeliveries")).toMatchObject({
      partitionKey: { name: "id" },
      gsis: [
        {
          name: "state-dueAt",
          partitionKey: { name: "state", type: "S" },
          sortKey: { name: "dueAt", type: "S" },
        },
      ],
    });
    const sessions = DYNAMO_TABLES.find((t) => t.name === "Sessions");
    expect(sessions?.gsis?.some((g) => g.name === "statusShard-createdAt")).toBe(true);
    expect(sessions?.gsis?.some((g) => g.name === "repositoryId-createdAt")).toBe(true);
    expect(statusShardKey("queued", 2)).toBe("queued#2");
    expect(describeControlPlane().tables).toBe(DYNAMO_TABLES);
    expect(getServiceName()).toBe("@auto-harness/cdk");
  });
});
