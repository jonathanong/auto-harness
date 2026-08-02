import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Default endpoint for amazon/dynamodb-local (docker compose). */
export const DEFAULT_DYNAMODB_ENDPOINT = "http://127.0.0.1:8000";

export type DynamoTableNames = {
  sessions: string;
  worktrees: string;
  connections: string;
  sessionLogs: string;
  schedules: string;
  agentLocks: string;
  archives: string;
};

export function tableNames(prefix = "AutoHarness"): DynamoTableNames {
  const p = prefix.replace(/[^a-zA-Z0-9_.-]/g, "") || "AutoHarness";
  return {
    sessions: `${p}-Sessions`,
    worktrees: `${p}-Worktrees`,
    connections: `${p}-Connections`,
    sessionLogs: `${p}-SessionLogs`,
    schedules: `${p}-Schedules`,
    agentLocks: `${p}-AgentLocks`,
    archives: `${p}-Archives`,
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
 * Local defaults: endpoint :8000, dummy credentials (required by the SDK).
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
