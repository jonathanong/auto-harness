import { pathToFileURL } from "node:url";

import { createDynamoClients, tableNames } from "../services/api/src/db/dynamo.ts";
import { migrateSessionDrainActivityLedgerPage } from "../services/api/src/db/ensure-session-drain-ledger.ts";

const MAX_PAGE_ATTEMPTS = 100_000;

export async function migrateUntilReady(
  migratePage: () => Promise<boolean>,
  maxAttempts = MAX_PAGE_ATTEMPTS,
): Promise<number> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("migration page-attempt limit must be a positive safe integer");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await migratePage()) return attempt;
  }
  throw new Error(
    `session-drain activity ledger did not become ready after ${maxAttempts} bounded page attempts`,
  );
}

async function main(): Promise<void> {
  const environment = process.env.HARNESS_DEPLOY_ENVIRONMENT ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(environment)) {
    throw new Error("HARNESS_DEPLOY_ENVIRONMENT must be a valid environment name");
  }
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
  const clients = createDynamoClients({ endpoint: null, region });
  const tables = tableNames(`AutoHarness-${environment}`);
  try {
    const attempts = await migrateUntilReady(() =>
      migrateSessionDrainActivityLedgerPage(clients.doc, tables),
    );
    console.log(`Session-drain activity ledger ready after ${attempts} page attempt(s).`);
  } finally {
    clients.client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
