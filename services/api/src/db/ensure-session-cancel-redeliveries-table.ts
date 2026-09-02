import {
  BillingMode,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";

export function sessionCancelRedeliveriesTableDefinition(
  tableName: string,
): CreateTableCommandInput & { TableName: string } {
  return {
    TableName: tableName,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "sessionId", AttributeType: ScalarAttributeType.S },
      { AttributeName: "status", AttributeType: ScalarAttributeType.S },
      { AttributeName: "queuedAt", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "sessionId", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        // `queuedAt` starts equal to `createdAt` but is bumped forward whenever a
        // candidate can't be redelivered yet (host disconnected) — see
        // `deferPendingCancelRedelivery` — so a run of stuck rows cycles to the
        // back of this index instead of permanently occupying the oldest page.
        IndexName: "status-queuedAt",
        KeySchema: [
          { AttributeName: "status", KeyType: KeyType.HASH },
          { AttributeName: "queuedAt", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  };
}
