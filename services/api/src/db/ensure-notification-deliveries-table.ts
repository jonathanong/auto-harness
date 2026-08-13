import {
  BillingMode,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";

export function notificationDeliveriesTableDefinition(
  tableName: string,
): CreateTableCommandInput & { TableName: string } {
  return {
    TableName: tableName,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: ScalarAttributeType.S },
      { AttributeName: "status", AttributeType: ScalarAttributeType.S },
      { AttributeName: "nextAttemptAt", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "status-nextAttemptAt",
        KeySchema: [
          { AttributeName: "status", KeyType: KeyType.HASH },
          { AttributeName: "nextAttemptAt", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  };
}
