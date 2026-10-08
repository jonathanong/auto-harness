import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { migrateOperationalActivityLedgerPage } from "../src/db/ensure-operational-activity-ledger.ts";

const sessions = process.env.HARNESS_MIGRATION_SESSIONS_TABLE;
const sessionDrains = process.env.HARNESS_MIGRATION_DRAINS_TABLE;
if (!sessions || !sessionDrains) {
  throw new Error("operational-ledger migration requires Sessions and SessionDrains table names");
}

const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const doc = DynamoDBDocumentClient.from(client);
try {
  const maxPages = 1_000;
  let ready = false;
  for (let page = 0; page < maxPages && !ready; page += 1) {
    ready = await migrateOperationalActivityLedgerPage(doc, { sessions, sessionDrains });
  }
  if (!ready)
    throw new Error(
      "operational-ledger migration page cap reached; rerun while maintenance remains fenced",
    );
} finally {
  doc.destroy();
}
