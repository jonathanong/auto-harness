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
import { setTimeout as delay } from "node:timers/promises";

import { SESSION_LOGS_TTL_ATTRIBUTE, tableNames, type DynamoTableNames } from "./dynamo.ts";
import { integrationsTableDefinition } from "./ensure-integrations-table.ts";
import { notificationDeliveriesTableDefinition } from "./ensure-notification-deliveries-table.ts";
import {
  enableRateLimitTtl,
  enableTableTtl,
  rateLimitTableDefinition,
} from "./ensure-rate-limit-table.ts";
import { sessionCancelRedeliveriesTableDefinition } from "./ensure-session-cancel-redeliveries-table.ts";
import { viewerTicketsTableDefinition } from "./ensure-viewer-tickets-table.ts";
import {
  backfillQueuedSessionQueueOrder,
  ensureSessionsQueueOrderIndex,
} from "./ensure-queue-order-index.ts";
import { ensureSessionsPriorityIndexes } from "./ensure-session-priority-index.ts";
import {
  ensureSchedulesRepositoryIndex,
  ensureSessionsRepositoryIndex,
} from "./ensure-session-index.ts";
import { migrateSessionDrainActivityLedgerPage } from "./ensure-session-drain-ledger.ts";
import { migrateSessionPriorityOrderPage } from "./ensure-session-priority-order.ts";
import { ensureArchivesRetryIndex } from "./ensure-archive-retry-index.ts";
import { ensureSessionsActiveHostIndex } from "./ensure-active-host-index.ts";
import { webhookDeliveriesTableDefinition } from "./ensure-webhook-deliveries-table.ts";

const LOCAL_SESSION_LIST_MIGRATION_MAX_ATTEMPTS = 100_000;
const LOCAL_SESSION_LIST_MIGRATION_RETRY_MS = 1;

export async function completeLocalSessionListMigration(
  doc: DynamoDBDocumentClient,
  names: Pick<DynamoTableNames, "sessions" | "sessionDrains">,
  maxAttempts = LOCAL_SESSION_LIST_MIGRATION_MAX_ATTEMPTS,
  migratePage: typeof migrateSessionPriorityOrderPage = migrateSessionPriorityOrderPage,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await migratePage(doc, names)) return;
    // A false result is either another bounded page or a concurrent lease holder.
    // Yield before retrying so independent local bootstraps make progress fairly.
    await delay(LOCAL_SESSION_LIST_MIGRATION_RETRY_MS);
  }
  throw new Error(
    `local session-list migration did not become ready after ${maxAttempts} bounded page attempts`,
  );
}
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
      { AttributeName: "createdOrder", AttributeType: ScalarAttributeType.S },
      { AttributeName: "queueOrder", AttributeType: ScalarAttributeType.S },
      { AttributeName: "priorityOrder", AttributeType: ScalarAttributeType.S },
      { AttributeName: "repositoryPriorityOrder", AttributeType: ScalarAttributeType.S },
      { AttributeName: "repositoryId", AttributeType: ScalarAttributeType.S },
      { AttributeName: "activeHostId", AttributeType: ScalarAttributeType.S },
      { AttributeName: "activeHostOrder", AttributeType: ScalarAttributeType.S },
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
        IndexName: "statusShard-createdOrder",
        KeySchema: [
          { AttributeName: "statusShard", KeyType: KeyType.HASH },
          { AttributeName: "createdOrder", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
      {
        IndexName: "statusShard-queueOrder",
        KeySchema: [
          { AttributeName: "statusShard", KeyType: KeyType.HASH },
          { AttributeName: "queueOrder", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
      {
        IndexName: "statusShard-priorityOrder",
        KeySchema: [
          { AttributeName: "statusShard", KeyType: KeyType.HASH },
          { AttributeName: "priorityOrder", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
      {
        IndexName: "statusShard-repositoryPriorityOrder",
        KeySchema: [
          { AttributeName: "statusShard", KeyType: KeyType.HASH },
          { AttributeName: "repositoryPriorityOrder", KeyType: KeyType.RANGE },
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
      {
        IndexName: "activeHostId-activeHostOrder",
        KeySchema: [
          { AttributeName: "activeHostId", KeyType: KeyType.HASH },
          { AttributeName: "activeHostOrder", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.KEYS_ONLY },
      },
    ],
  });

  await ensureSessionsRepositoryIndex(ddb, names.sessions);
  await ensureSessionsQueueOrderIndex(ddb, names.sessions);
  await ensureSessionsPriorityIndexes(ddb, names.sessions);
  await ensureSessionsActiveHostIndex(ddb, names.sessions);
  await backfillQueuedSessionQueueOrder(DynamoDBDocumentClient.from(ddb), names.sessions);

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
  await migrateSessionDrainActivityLedgerPage(DynamoDBDocumentClient.from(ddb), {
    sessions: names.sessions,
    sessionDrains: names.sessionDrains,
  });
  // Lambda production paths use skipEnsureTables and the fenced deployment driver.
  // Local/bootstrap callers must complete the resumable migration before reads
  // switch to the sparse created-order GSI.
  await completeLocalSessionListMigration(DynamoDBDocumentClient.from(ddb), names);

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
  await enableTableTtl(ddb, names.sessionLogs, SESSION_LOGS_TTL_ATTRIBUTE);

  await createIfMissing(ddb, {
    TableName: names.schedules,
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
  await ensureSchedulesRepositoryIndex(ddb, names.schedules);

  await createIfMissing(ddb, {
    TableName: names.repositories,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
  });

  await createIfMissing(ddb, {
    TableName: names.archives,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "key", AttributeType: ScalarAttributeType.S },
      { AttributeName: "retryState", AttributeType: ScalarAttributeType.S },
      { AttributeName: "retryOrder", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "key", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "retryState-retryOrder",
        KeySchema: [
          { AttributeName: "retryState", KeyType: KeyType.HASH },
          { AttributeName: "retryOrder", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  });
  await ensureArchivesRetryIndex(ddb, names.archives);

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
  await createIfMissing(ddb, viewerTicketsTableDefinition(names.viewerTickets));
  await enableRateLimitTtl(ddb, names.viewerTickets);
  await createIfMissing(ddb, integrationsTableDefinition(names.integrations));
  await createIfMissing(ddb, {
    TableName: names.slackOAuthStates,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "stateHash", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "stateHash", KeyType: KeyType.HASH }],
  });
  await enableTableTtl(ddb, names.slackOAuthStates, "expiresAt");
  await createIfMissing(ddb, {
    TableName: names.slackInboundEvents,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "workspaceId", AttributeType: ScalarAttributeType.S },
      { AttributeName: "eventId", AttributeType: ScalarAttributeType.S },
      { AttributeName: "status", AttributeType: ScalarAttributeType.S },
      { AttributeName: "dueOrder", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [
      { AttributeName: "workspaceId", KeyType: KeyType.HASH },
      { AttributeName: "eventId", KeyType: KeyType.RANGE },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "status-dueOrder",
        KeySchema: [
          { AttributeName: "status", KeyType: KeyType.HASH },
          { AttributeName: "dueOrder", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  });
  await enableTableTtl(ddb, names.slackInboundEvents, "ttl");
  await createIfMissing(ddb, notificationDeliveriesTableDefinition(names.notificationDeliveries));
  await createIfMissing(ddb, webhookDeliveriesTableDefinition(names.webhookDeliveries));
  await createIfMissing(
    ddb,
    sessionCancelRedeliveriesTableDefinition(names.sessionCancelRedeliveries),
  );

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
