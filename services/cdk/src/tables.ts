/**
 * DynamoDB table definitions for Auto Harness (docs/plan.md §4, aws.md).
 * The CDK foundation stack consumes this catalog, and local DynamoDB setup
 * mirrors it. Keep the catalog in sync with `services/api/src/db/ensure-tables.ts`.
 */

export type TableDef = {
  name: string;
  partitionKey: { name: string; type: "S" | "N" };
  sortKey?: { name: string; type: "S" | "N" };
  gsis?: Array<{
    name: string;
    partitionKey: { name: string; type: "S" | "N" };
    sortKey?: { name: string; type: "S" | "N" };
  }>;
  ttlAttribute?: string;
};

export const DYNAMO_TABLES: TableDef[] = [
  {
    name: "Users",
    partitionKey: { name: "id", type: "S" },
    gsis: [{ name: "username", partitionKey: { name: "username", type: "S" } }],
  },
  {
    name: "Repositories",
    partitionKey: { name: "id", type: "S" },
  },
  {
    name: "Worktrees",
    partitionKey: { name: "id", type: "S" },
    gsis: [
      {
        name: "repositoryId-id",
        partitionKey: { name: "repositoryId", type: "S" },
        sortKey: { name: "id", type: "S" },
      },
    ],
  },
  {
    name: "Sessions",
    partitionKey: { name: "id", type: "S" },
    gsis: [
      {
        // Sharded queue: status#shard → createdAt
        name: "statusShard-createdAt",
        partitionKey: { name: "statusShard", type: "S" },
        sortKey: { name: "createdAt", type: "S" },
      },
      {
        name: "repositoryId-createdAt",
        partitionKey: { name: "repositoryId", type: "S" },
        sortKey: { name: "createdAt", type: "S" },
      },
    ],
  },
  {
    name: "SessionDrains",
    partitionKey: { name: "scopeKey", type: "S" },
    sortKey: { name: "recordKey", type: "S" },
  },
  {
    name: "HostLocks",
    partitionKey: { name: "hostId", type: "S" },
  },
  {
    name: "ConcurrencyLocks",
    partitionKey: { name: "concurrencyId", type: "S" },
    ttlAttribute: "ttl",
  },
  {
    name: "SessionLogs",
    partitionKey: { name: "sessionId", type: "S" },
    sortKey: { name: "timestampSeq", type: "S" },
    ttlAttribute: "ttl",
  },
  {
    name: "Schedules",
    partitionKey: { name: "id", type: "S" },
  },
  {
    name: "Connections",
    partitionKey: { name: "connectionId", type: "S" },
  },
  {
    name: "Archives",
    partitionKey: { name: "key", type: "S" },
  },
  {
    name: "HostInventories",
    partitionKey: { name: "hostId", type: "S" },
  },
  {
    name: "AuditLogs",
    // One append-only control-plane partition supports newest-first cursor
    // pagination. The audit event id remains an immutable payload attribute.
    partitionKey: { name: "scope", type: "S" },
    sortKey: { name: "timestampId", type: "S" },
  },
  {
    name: "RateLimits",
    partitionKey: { name: "bucketKey", type: "S" },
    ttlAttribute: "expiresAt",
  },
  {
    name: "Providers",
    partitionKey: { name: "id", type: "S" },
  },
  {
    name: "ProviderAccounts",
    partitionKey: { name: "id", type: "S" },
  },
  {
    name: "Commands",
    partitionKey: { name: "id", type: "S" },
  },
  {
    name: "SessionUsage",
    partitionKey: { name: "sessionId", type: "S" },
    sortKey: { name: "usageKey", type: "S" },
  },
  {
    name: "SessionUsageKinds",
    partitionKey: { name: "sessionAttempt", type: "S" },
  },
  {
    name: "Integrations",
    partitionKey: { name: "id", type: "S" },
  },
  {
    name: "NotificationDeliveries",
    partitionKey: { name: "id", type: "S" },
    gsis: [
      {
        name: "status-nextAttemptAt",
        partitionKey: { name: "status", type: "S" },
        sortKey: { name: "nextAttemptAt", type: "S" },
      },
    ],
  },
  {
    name: "WebhookDeliveries",
    partitionKey: { name: "id", type: "S" },
    gsis: [
      {
        name: "state-dueAt",
        partitionKey: { name: "state", type: "S" },
        sortKey: { name: "dueAt", type: "S" },
      },
    ],
  },
];

export const S3_ARCHIVE_BUCKET = {
  name: "auto-harness-session-archives",
  purpose: "Completed session log archival (Phase 5)",
} as const;

export const EVENTBRIDGE_CRON = {
  rate: "rate(1 minute)",
  target: "CronEvaluatorLambda",
} as const;

export function statusShardKey(status: string, shard: number): string {
  return `${status}#${shard}`;
}

export function describeControlPlane(): {
  tables: TableDef[];
  archiveBucket: typeof S3_ARCHIVE_BUCKET;
  cron: typeof EVENTBRIDGE_CRON;
} {
  return {
    tables: DYNAMO_TABLES,
    archiveBucket: S3_ARCHIVE_BUCKET,
    cron: EVENTBRIDGE_CRON,
  };
}
