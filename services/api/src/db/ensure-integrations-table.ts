import {
  BillingMode,
  type CreateTableCommandInput,
  KeyType,
  ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";

export function integrationsTableDefinition(
  tableName: string,
): CreateTableCommandInput & { TableName: string } {
  return {
    TableName: tableName,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
  };
}
