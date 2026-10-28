import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { encodeStoredArgv } from "../session-argv-storage.ts";
import type { DynamoTableNames } from "./dynamo.ts";
import { isConditionalFailed, nextPageKey } from "./plane-storage-types.ts";

const SCAN_LIMIT = 100;

/** Rows written before argv was stored with the prompt factored out still repeat it in full. */
function repeatsPrompt(item: Record<string, unknown>): item is {
  id: string;
  prompt: string;
  resolvedArgv: string[];
} {
  const { prompt, resolvedArgv } = item;
  return (
    typeof prompt === "string" &&
    prompt !== "" &&
    Array.isArray(resolvedArgv) &&
    resolvedArgv.every((arg) => typeof arg === "string") &&
    resolvedArgv.some((arg: string) => arg.includes(prompt))
  );
}

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
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  let compacted = 0;
  for (const item of (page.Items ?? []) as Record<string, unknown>[]) {
    if (!repeatsPrompt(item)) continue;
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tables.sessions,
          Key: { id: item.id },
          UpdateExpression: "SET resolvedArgv = :stored",
          ConditionExpression: "#prompt = :prompt AND resolvedArgv = :argv",
          ExpressionAttributeNames: { "#prompt": "prompt" },
          ExpressionAttributeValues: {
            ":stored": encodeStoredArgv(item.resolvedArgv, item.prompt),
            ":prompt": item.prompt,
            ":argv": item.resolvedArgv,
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
