import { ListTablesCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoClients, DEFAULT_DYNAMODB_ENDPOINT } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";

export { createDynamoClients, ensureControlPlaneTables };

export async function waitForDynamo(maxMs = 30_000): Promise<void> {
  const { client } = createDynamoClients();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(
    `DynamoDB Local not reachable at ${process.env.HARNESS_DDB_ENDPOINT ?? DEFAULT_DYNAMODB_ENDPOINT}. Run: pnpm local:dynamodb`,
  );
}

export async function listDynamoTables(client: DynamoDBClient): Promise<string[]> {
  const names: string[] = [];
  let exclusiveStartTableName: string | undefined;

  do {
    const listed = await client.send(
      new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }),
    );
    names.push(...normalizeTableNames(listed.TableNames));
    exclusiveStartTableName = listed.LastEvaluatedTableName;
  } while (exclusiveStartTableName);

  return names;
}

export function normalizeTableNames(names: string[] | undefined): string[] {
  return names ?? [];
}
