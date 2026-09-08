import { pathToFileURL } from "node:url";

import { createDynamoClients, tableNames } from "../services/api/src/db/dynamo.ts";
import { migrateSessionPriorityOrderPage } from "../services/api/src/db/ensure-session-priority-order.ts";
import { migrateUntilReady } from "./migrate-session-drain-ledger.mts";

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
      migrateSessionPriorityOrderPage(clients.doc, tables),
    );
    console.log(`Session priority-order index ready after ${attempts} page attempt(s).`);
  } finally {
    clients.client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
