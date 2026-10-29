import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { compactSessionArgvPage } from "../src/db/session-argv-compaction.ts";

const sessions = process.env.HARNESS_MIGRATION_SESSIONS_TABLE;
if (!sessions) throw new Error("session argv compaction requires the Sessions table name");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
try {
  // Safe while the API is live and to rerun: rows already compacted are skipped.
  let total = 0;
  let nextKey: Record<string, unknown> | undefined;
  do {
    const page = await compactSessionArgvPage(doc, { sessions }, nextKey);
    total += page.compacted;
    nextKey = page.nextKey;
  } while (nextKey);
  console.log(`compacted resolvedArgv on ${total} Session rows`);
} finally {
  doc.destroy();
}
