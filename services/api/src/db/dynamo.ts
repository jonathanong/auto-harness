import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Default endpoint for amazon/dynamodb-local (docker compose host port). */
export const DEFAULT_DYNAMODB_ENDPOINT = "http://127.0.0.1:7423";

export type DynamoTableNames = {
  users: string;
  sessions: string;
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
};

export function tableNames(prefix = "AutoHarness"): DynamoTableNames {
  const p = prefix.replace(/[^a-zA-Z0-9_.-]/g, "") || "AutoHarness";
  return {
    users: `${p}-Users`,
    sessions: `${p}-Sessions`,
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
  };
}

export type CreateDynamoClientOptions = {
  endpoint?: string;
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
    options.endpoint ?? process.env.HARNESS_DDB_ENDPOINT ?? DEFAULT_DYNAMODB_ENDPOINT;
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
  const client = new DynamoDBClient({
    region,
    endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
    },
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
