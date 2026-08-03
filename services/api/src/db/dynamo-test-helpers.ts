import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll } from "vitest";

import { createDynamoClients } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";

export async function dynamoAvailable(): Promise<boolean> {
  try {
    const { client } = createDynamoClients();
    await client.send(new ListTablesCommand({}));
    return true;
  } catch {
    return false;
  }
}

export type DynamoTestCtx = {
  prefix: string;
  storage: DynamoPlaneStorage | null;
  available: boolean;
};

/** Per-file DynamoDB Local fixture with an isolated table prefix. */
export function createDynamoTestCtx(label: string): DynamoTestCtx {
  const ctx: DynamoTestCtx = {
    prefix: `Ah${label}${process.pid}`.slice(0, 20),
    storage: null,
    available: false,
  };

  beforeAll(async () => {
    ctx.available = await dynamoAvailable();
    if (!ctx.available) {
      return;
    }
    const { client, doc } = createDynamoClients();
    const names = await ensureControlPlaneTables({ client, prefix: ctx.prefix });
    ctx.storage = new DynamoPlaneStorage(doc, names);
    await ctx.storage.clearAll();
  });

  afterAll(async () => {
    if (ctx.storage) {
      await ctx.storage.clearAll();
    }
  });

  return ctx;
}
