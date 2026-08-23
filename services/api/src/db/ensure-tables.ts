/* eslint-disable max-lines */
import {
  BillingMode,
  CreateTableCommand,
  type CreateTableCommandInput,
  DescribeTableCommand,
  type DynamoDBClient,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { tableNames, type DynamoTableNames } from "./dynamo.ts";
import { integrationsTableDefinition } from "./ensure-integrations-table.ts";
import { notificationDeliveriesTableDefinition } from "./ensure-notification-deliveries-table.ts";
import { enableRateLimitTtl, rateLimitTableDefinition } from "./ensure-rate-limit-table.ts";
import { ensureSessionsRepositoryIndex } from "./ensure-session-index.ts";
import { ensureSessionDrainActivityLedger } from "./ensure-session-drain-ledger.ts";
import { webhookDeliveriesTableDefinition } from "./ensure-webhook-deliveries-table.ts";

async function tableExists(client: DynamoDBClient, name: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch {
    return false;
  }
}

async function createIfMissing(
  client: DynamoDBClient,
  input: CreateTableCommandInput & { TableName: string },
): Promise<boolean> {
  if (await tableExists(client, input.TableName)) return false;
  try {
    await client.send(new CreateTableCommand(input));
    return true;
  } catch (err) {
    if (err instanceof ResourceInUseException) {
      return false;
    }
    throw err;
  }
}

/**
 * Create control-plane tables on DynamoDB Local (or AWS) if missing.
 * Schema aligns with services/cdk (sharded queue GSI, timestampSeq SK).
 */
export async function ensureControlPlaneTables(opts: {
  client: DynamoDBClient;
  prefix?: string;
}): Promise<DynamoTableNames> {
  const names = tableNames(opts.prefix ?? process.env.HARNESS_DDB_PREFIX ?? "AutoHarness");
  const ddb = opts.client;
  await createIfMissing(ddb, {
    TableName: names.users,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: ScalarAttributeType.S },
      { AttributeName: "username", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "username",
        KeySchema: [{ AttributeName: "username", KeyType: KeyType.HASH }],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  });
  await createIfMissing(ddb, {
    TableName: names.sessions,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: ScalarAttributeType.S },
      { AttributeName: "statusShard", AttributeType: ScalarAttributeType.S },
      { AttributeName: "createdAt", AttributeType: ScalarAttributeType.S },
      { AttributeName: "repositoryId", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "statusShard-createdAt",
        KeySchema: [
          { AttributeName: "statusShard", KeyType: KeyType.HASH },
          { AttributeName: "createdAt", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
      {
        IndexName: "repositoryId-createdAt",
        KeySchema: [
          { AttributeName: "repositoryId", KeyType: KeyType.HASH },
          { AttributeName: "createdAt", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  });

  await ensureSessionsRepositoryIndex(ddb, names.sessions);

  await createIfMissing(ddb, {
    TableName: names.sessionDrains,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "scopeKey", AttributeType: ScalarAttributeType.S },
      { AttributeName: "recordKey", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [
      { AttributeName: "scopeKey", KeyType: KeyType.HASH },
      { AttributeName: "recordKey", KeyType: KeyType.RANGE },
    ],
  });
  await ensureSessionDrainActivityLedger(DynamoDBDocumentClient.from(ddb), {
    sessions: names.sessions,
    sessionDrains: names.sessionDrains,
  });

  await createIfMissing(ddb, {
    TableName: names.worktrees,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: ScalarAttributeType.S },
      { AttributeName: "repositoryId", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "repositoryId-id",
        KeySchema: [
          { AttributeName: "repositoryId", KeyType: KeyType.HASH },
          { AttributeName: "id", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  });

  await createIfMissing(ddb, {
    TableName: names.connections,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "connectionId", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "connectionId", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.hostLocks,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "hostId", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "hostId", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.concurrencyLocks,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "concurrencyId", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "concurrencyId", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.sessionLogs,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "sessionId", AttributeType: ScalarAttributeType.S },
      { AttributeName: "timestampSeq", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [
      { AttributeName: "sessionId", KeyType: KeyType.HASH },
      { AttributeName: "timestampSeq", KeyType: KeyType.RANGE },
    ],
  });

  await createIfMissing(ddb, {
    TableName: names.schedules,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.repositories,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.archives,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "key", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "key", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.hostInventories,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "hostId", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "hostId", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.providers,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.providerAccounts,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.commands,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.auditLogs,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "scope", AttributeType: ScalarAttributeType.S },
      { AttributeName: "timestampId", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [
      { AttributeName: "scope", KeyType: KeyType.HASH },
      { AttributeName: "timestampId", KeyType: KeyType.RANGE },
    ],
  });

  await createIfMissing(ddb, rateLimitTableDefinition(names.rateLimits));
  await enableRateLimitTtl(ddb, names.rateLimits);
  await createIfMissing(ddb, integrationsTableDefinition(names.integrations));
  await createIfMissing(ddb, notificationDeliveriesTableDefinition(names.notificationDeliveries));
  await createIfMissing(ddb, webhookDeliveriesTableDefinition(names.webhookDeliveries));

  await createIfMissing(ddb, {
    TableName: names.sessionUsage,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "sessionId", AttributeType: ScalarAttributeType.S },
      { AttributeName: "usageKey", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [
      { AttributeName: "sessionId", KeyType: KeyType.HASH },
      { AttributeName: "usageKey", KeyType: KeyType.RANGE },
    ],
  });

  await createIfMissing(ddb, {
    TableName: names.sessionUsageKinds,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "sessionAttempt", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "sessionAttempt", KeyType: KeyType.HASH }],
  });
  return names;
}
