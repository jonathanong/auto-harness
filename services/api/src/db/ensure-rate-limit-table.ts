import {
  BillingMode,
  type CreateTableCommand,
  DescribeTimeToLiveCommand,
  type DynamoDBClient,
  KeyType,
  ScalarAttributeType,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";

export function rateLimitTableDefinition(
  name: string,
): ConstructorParameters<typeof CreateTableCommand>[0] & { TableName: string } {
  return {
    TableName: name,
    BillingMode: BillingMode.PAY_PER_REQUEST,
    AttributeDefinitions: [{ AttributeName: "bucketKey", AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: "bucketKey", KeyType: KeyType.HASH }],
  };
}

export async function enableRateLimitTtl(client: DynamoDBClient, name: string): Promise<void> {
  const current = await client.send(new DescribeTimeToLiveCommand({ TableName: name }));
  if (["ENABLED", "ENABLING"].includes(current.TimeToLiveDescription?.TimeToLiveStatus ?? "")) {
    return;
  }
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: name,
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      }),
    );
  } catch (error) {
    if (
      (error as { name?: unknown }).name === "ValidationException" &&
      error instanceof Error &&
      error.message.includes("TimeToLive is already enabled")
    ) {
      return;
    }
    throw error;
  }
}
