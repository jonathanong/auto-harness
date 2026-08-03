import {
  BillingMode,
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";

import { tableNames, type DynamoTableNames } from "./dynamo.ts";

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
  input: ConstructorParameters<typeof CreateTableCommand>[0],
): Promise<void> {
  if (!input?.TableName) {
    return;
  }
  if (await tableExists(client, input.TableName)) {
    return;
  }
  try {
    await client.send(new CreateTableCommand(input));
  } catch (err) {
    if (err instanceof ResourceInUseException) {
      return;
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
    TableName: names.sessions,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: ScalarAttributeType.S },
      { AttributeName: "statusShard", AttributeType: ScalarAttributeType.S },
      { AttributeName: "createdAt", AttributeType: ScalarAttributeType.S },
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
    ],
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
    TableName: names.agentLocks,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "agentId", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "agentId", KeyType: KeyType.HASH }],
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

  return names;
}
