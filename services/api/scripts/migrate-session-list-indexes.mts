import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { migrateSessionListIndexesPage } from "../src/db/ensure-session-list-backfill.ts";
import { sessionListIndexesActive } from "../src/db/ensure-session-list-indexes.ts";

const sessions = process.env.HARNESS_MIGRATION_SESSIONS_TABLE;
const sessionDrains = process.env.HARNESS_MIGRATION_DRAINS_TABLE;
if (!sessions || !sessionDrains) {
  throw new Error("session-list backfill requires Sessions and SessionDrains table names");
}

const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const doc = DynamoDBDocumentClient.from(client);
try {
  if (!(await sessionListIndexesActive(client, sessions))) {
    throw new Error("session-list backfill requires every unsharded list index to be ACTIVE");
  }
  // Resumable: rerunning continues from the stored scan key and is safe while the API is live.
  const maxPages = 10_000;
  let ready = false;
  for (let page = 0; page < maxPages && !ready; page += 1) {
    ready = await migrateSessionListIndexesPage(doc, { sessions, sessionDrains });
  }
  if (!ready) throw new Error("session-list backfill page cap reached; rerun to resume");
} finally {
  doc.destroy();
}
