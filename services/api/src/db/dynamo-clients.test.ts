import { describe, expect, it } from "vitest";

import {
  createDynamoClients,
  createDynamoDocumentClient,
  DEFAULT_DYNAMODB_ENDPOINT,
  statusShardAttr,
  tableNames,
} from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Cli");

describe("DynamoDB Local clients", () => {
  it("exports client helpers and table naming", () => {
    expect(statusShardAttr("queued", 2)).toBe("queued#2");
    expect(tableNames("AH").sessions).toBe("AH-Sessions");
    expect(tableNames("").sessions).toContain("Sessions");
    expect(DEFAULT_DYNAMODB_ENDPOINT).toContain("7422");
    const doc = createDynamoDocumentClient();
    expect(doc).toBeTruthy();
  });

  it("ensureControlPlaneTables is idempotent", async () => {
    if (!ctx.available) {
      expect(true).toBe(true);
      return;
    }
    const { client } = createDynamoClients();
    const a = await ensureControlPlaneTables({ client, prefix: ctx.prefix });
    const b = await ensureControlPlaneTables({ client, prefix: ctx.prefix });
    expect(a.sessions).toBe(b.sessions);
  });
});
