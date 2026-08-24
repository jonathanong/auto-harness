import {
  BillingMode,
  type CreateTableCommand,
  KeyType,
  ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";

export function viewerTicketsTableDefinition(
  name: string,
): ConstructorParameters<typeof CreateTableCommand>[0] & { TableName: string } {
  return {
    TableName: name,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "ticketHash", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "ticketHash", KeyType: KeyType.HASH }],
  };
}
