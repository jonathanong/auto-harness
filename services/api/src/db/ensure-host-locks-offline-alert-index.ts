import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

/**
 * Sparse GSI on HostLocks: only hosts with a pending offline alert are indexed.
 * `offlineAlertPending` is written and removed in lockstep with
 * offlineAlertReason/offlineAlertLastHeartbeatAt (see plane-storage-locks.ts) so
 * a cleared alert falls out of the index instead of lingering as a stale row.
 */
export const HOST_LOCKS_OFFLINE_ALERT_INDEX = "offlineAlertPending-hostId";
/** The only value ever written to the sparse marker attribute. */
export const HOST_OFFLINE_ALERT_PENDING = "pending";

function isIgnorableIndexUpdate(error: unknown): boolean {
  return (
    error instanceof ResourceInUseException ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "LimitExceededException")
  );
}

/** Add the sparse offline-alert access path to HostLocks tables created before this GSI existed. */
export async function ensureHostLocksOfflineAlertIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  let table;
  try {
    table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch {
    return;
  }
  if (
    table.Table?.GlobalSecondaryIndexes?.some(
      (index) => index.IndexName === HOST_LOCKS_OFFLINE_ALERT_INDEX,
    )
  ) {
    return;
  }
  // hostId is already the table's partition key (and thus already declared and
  // projected into every GSI); only the new sparse marker attribute needs adding.
  const definitions = table.Table?.AttributeDefinitions ?? [];
  const withDefinitions = definitions.some(
    (definition) => definition.AttributeName === "offlineAlertPending",
  )
    ? definitions
    : [
        ...definitions,
        { AttributeName: "offlineAlertPending", AttributeType: ScalarAttributeType.S },
      ];
  try {
    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: withDefinitions,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: HOST_LOCKS_OFFLINE_ALERT_INDEX,
              KeySchema: [
                { AttributeName: "offlineAlertPending", KeyType: KeyType.HASH },
                { AttributeName: "hostId", KeyType: KeyType.RANGE },
              ],
              Projection: { ProjectionType: ProjectionType.ALL },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isIgnorableIndexUpdate(error)) throw error;
  }
}
