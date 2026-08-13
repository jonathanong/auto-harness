import {
  BillingMode,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";

export function webhookDeliveriesTableDefinition(
  tableName: string,
): CreateTableCommandInput & { TableName: string } {
  return {
    TableName: tableName,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: ScalarAttributeType.S },
      { AttributeName: "state", AttributeType: ScalarAttributeType.S },
      { AttributeName: "dueAt", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "state-dueAt",
        KeySchema: [
          { AttributeName: "state", KeyType: KeyType.HASH },
          { AttributeName: "dueAt", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  };
}
