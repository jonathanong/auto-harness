import { DescribeTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { SESSIONS_ACTIVE_HOST_INDEX } from "./plane-storage-sessions-active-host.ts";

/** Refuse an unsafe reader cutover on a pre-existing or still-building table. */
export async function ensureSessionsActiveHostIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const index = table.Table?.GlobalSecondaryIndexes?.find(
    (candidate) => candidate.IndexName === SESSIONS_ACTIVE_HOST_INDEX,
  );
  if (!index || index.IndexStatus !== "ACTIVE") {
    throw new Error(
      `Sessions table requires active ${SESSIONS_ACTIVE_HOST_INDEX}; deploy a fresh environment before enabling these readers`,
    );
  }
}
