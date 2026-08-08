/**
 * DynamoDB table definitions for Auto Harness (docs/plan.md §4, aws.md).
 * Pure data — deploy via CDK stack when AWS credentials are available.
 */

type TableDef = {
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
        name: "hostId-status",
        partitionKey: { name: "hostId", type: "S" },
        sortKey: { name: "status", type: "S" },
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
    ],
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
    gsis: [
      {
        name: "nextRunAt",
        partitionKey: { name: "enabledKey", type: "S" },
        sortKey: { name: "nextRunAt", type: "S" },
      },
    ],
  },
  {
    name: "Connections",
    partitionKey: { name: "connectionId", type: "S" },
    gsis: [
      {
        // Conditional put uniqueness on hostId (Invariant 3)
        name: "hostId",
        partitionKey: { name: "hostId", type: "S" },
      },
    ],
  },
  {
    name: "AuditLogs",
    partitionKey: { name: "id", type: "S" },
    sortKey: { name: "createdAt", type: "S" },
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
