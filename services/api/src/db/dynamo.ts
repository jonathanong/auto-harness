import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Default endpoint for amazon/dynamodb-local (docker compose host port). */
export const DEFAULT_DYNAMODB_ENDPOINT = "http://127.0.0.1:7423";

export const SESSION_LOGS_TTL_ATTRIBUTE = "ttl";

/** Seconds from a SessionLogs write until DynamoDB TTL expiry. */
export const SESSION_LOGS_TTL_SECONDS = 7 * 24 * 60 * 60;

export function sessionLogsTtlEpochSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + SESSION_LOGS_TTL_SECONDS;
}

export type DynamoTableNames = {
  users: string;
  sessions: string;
  sessionDrains: string;
  worktrees: string;
  connections: string;
  sessionLogs: string;
  schedules: string;
  repositories: string;
  hostLocks: string;
  concurrencyLocks: string;
  archives: string;
  hostInventories: string;
  providers: string;
  providerAccounts: string;
  commands: string;
  auditLogs: string;
  rateLimits: string;
  viewerTickets: string;
  sessionUsage: string;
  sessionUsageKinds: string;
  integrations: string;
  notificationDeliveries: string;
  webhookDeliveries: string;
  sessionCancelRedeliveries: string;
};

export function tableNames(prefix = "AutoHarness"): DynamoTableNames {
  const p = prefix.replace(/[^a-zA-Z0-9_.-]/g, "") || "AutoHarness";
  return {
    users: `${p}-Users`,
    sessions: `${p}-Sessions`,
    sessionDrains: `${p}-SessionDrains`,
    worktrees: `${p}-Worktrees`,
    connections: `${p}-Connections`,
    sessionLogs: `${p}-SessionLogs`,
    schedules: `${p}-Schedules`,
    repositories: `${p}-Repositories`,
    hostLocks: `${p}-HostLocks`,
    concurrencyLocks: `${p}-ConcurrencyLocks`,
    archives: `${p}-Archives`,
    hostInventories: `${p}-HostInventories`,
    providers: `${p}-Providers`,
    providerAccounts: `${p}-ProviderAccounts`,
    commands: `${p}-Commands`,
    auditLogs: `${p}-AuditLogs`,
    rateLimits: `${p}-RateLimits`,
    viewerTickets: `${p}-ViewerTickets`,
    sessionUsage: `${p}-SessionUsage`,
    sessionUsageKinds: `${p}-SessionUsageKinds`,
    integrations: `${p}-Integrations`,
    notificationDeliveries: `${p}-NotificationDeliveries`,
    webhookDeliveries: `${p}-WebhookDeliveries`,
    sessionCancelRedeliveries: `${p}-SessionCancelRedeliveries`,
  };
}

export type CreateDynamoClientOptions = {
  /** DynamoDB endpoint. `null` selects the AWS regional endpoint. */
  endpoint?: string | null;
  region?: string;
};

type DynamoClients = {
  client: DynamoDBClient;
  doc: DynamoDBDocumentClient;
};

/**
 * Low-level + document clients for DynamoDB Local (or AWS).
 * Local defaults: endpoint :7423, dummy credentials (required by the SDK).
 */
export function createDynamoClients(options: CreateDynamoClientOptions = {}): DynamoClients {
  const endpoint =
    options.endpoint === null
      ? undefined
      : (options.endpoint ?? process.env.HARNESS_DDB_ENDPOINT ?? DEFAULT_DYNAMODB_ENDPOINT);
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
  const client = new DynamoDBClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(endpoint
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
          },
        }
      : {}),
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return { client, doc };
}

/** @deprecated prefer createDynamoClients */
export function createDynamoDocumentClient(
  options: CreateDynamoClientOptions = {},
): DynamoDBDocumentClient {
  return createDynamoClients(options).doc;
}

export function statusShardAttr(status: string, shard: number): string {
  return `${status}#${shard}`;
}
