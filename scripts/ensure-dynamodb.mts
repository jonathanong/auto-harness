/**
 * Wait for DynamoDB Local and ensure Auto Harness tables exist.
 * Usage: pnpm local:dynamodb:ready
 *
 * Imports only via @auto-harness/api so the AWS SDK resolves from that workspace package.
 */
import {
  createDynamoClients,
  ensureControlPlaneTables,
  listDynamoTables,
  waitForDynamo,
} from "../services/api/src/db/local-bootstrap.ts";

async function main(): Promise<void> {
  await waitForDynamo();
  const { client } = createDynamoClients();
  const names = await ensureControlPlaneTables({
    client,
    prefix: process.env.HARNESS_DDB_PREFIX ?? "AutoHarness",
  });
  const tables = await listDynamoTables(client);
  console.log(
    JSON.stringify({
      ok: true,
      endpoint: process.env.HARNESS_DDB_ENDPOINT ?? "http://127.0.0.1:7423",
      tables,
      expected: names,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
