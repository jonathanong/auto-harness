import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { legacyArgvCompaction } from "../session-argv-storage.ts";
import type { DynamoTableNames } from "./dynamo.ts";
import { isConditionalFailed, nextPageKey } from "./plane-storage-types.ts";

const SCAN_LIMIT = 100;

/**
 * Rewrite one page of legacy Session rows so `resolvedArgv` no longer repeats the prompt.
 * Each write is conditioned on the prompt and argv it read, so a row an assignment or a
 * resume fallback changed meanwhile is left to that writer. Idempotent and resumable.
 */
export async function compactSessionArgvPage(
  doc: DynamoDBDocumentClient,
  tables: Pick<DynamoTableNames, "sessions">,
  startKey?: Record<string, unknown>,
): Promise<{ compacted: number; nextKey: Record<string, unknown> | undefined }> {
  const page = await doc.send(
    new ScanCommand({
      TableName: tables.sessions,
      ConsistentRead: true,
      Limit: SCAN_LIMIT,
      ProjectionExpression: "id, #prompt, resolvedArgv",
      ExpressionAttributeNames: { "#prompt": "prompt" },
      ExclusiveStartKey: startKey,
    }),
  );
  let compacted = 0;
  for (const item of page.Items as Record<string, unknown>[]) {
    const compaction = legacyArgvCompaction(item);
    if (!compaction) continue;
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tables.sessions,
          Key: { id: item.id },
          UpdateExpression: "SET resolvedArgv = :stored",
          ConditionExpression: "#prompt = :prompt AND resolvedArgv = :argv",
          ExpressionAttributeNames: { "#prompt": "prompt" },
          ExpressionAttributeValues: {
            ":stored": compaction.stored,
            ":prompt": compaction.prompt,
            ":argv": compaction.argv,
          },
        }),
      );
      compacted += 1;
    } catch (error) {
      if (!isConditionalFailed(error)) throw error;
    }
  }
  return {
    compacted,
    nextKey: nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined),
  };
}
