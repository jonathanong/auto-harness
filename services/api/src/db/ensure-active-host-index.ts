import {
  DescribeTableCommand,
  ResourceNotFoundException,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

import { SESSIONS_ACTIVE_HOST_INDEX } from "./plane-storage-sessions-active-host.ts";

/** Refuse an unsafe reader cutover on a pre-existing or still-building table. */
export async function ensureSessionsActiveHostIndex(
  client: DynamoDBClient,
  tableName: string,
  options: { attempts?: number; retryMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 40;
  const retryMs = options.retryMs ?? 1_500;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
      const index = table.Table?.GlobalSecondaryIndexes?.find(
        (candidate) => candidate.IndexName === SESSIONS_ACTIVE_HOST_INDEX,
      );
      if (table.Table?.TableStatus === "ACTIVE" && index?.IndexStatus === "ACTIVE") return;
      const stillCreating =
        table.Table?.TableStatus === "CREATING" || index?.IndexStatus === "CREATING";
      if (!stillCreating) {
        throw new Error(
          `Sessions table requires active ${SESSIONS_ACTIVE_HOST_INDEX}; deploy a fresh environment before enabling these readers`,
        );
      }
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
      if (attempt === attempts) {
        throw new Error(`Sessions table and ${SESSIONS_ACTIVE_HOST_INDEX} did not become active`, {
          cause: error,
        });
      }
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  throw new Error(`Sessions table and ${SESSIONS_ACTIVE_HOST_INDEX} did not become active`);
}
