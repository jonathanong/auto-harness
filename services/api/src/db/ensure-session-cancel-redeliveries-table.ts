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
      { AttributeName: "createdAt", AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: "sessionId", KeyType: KeyType.HASH }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "status-createdAt",
        KeySchema: [
          { AttributeName: "status", KeyType: KeyType.HASH },
          { AttributeName: "createdAt", KeyType: KeyType.RANGE },
        ],
        Projection: { ProjectionType: ProjectionType.ALL },
      },
    ],
  };
}
