import { App, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";

import { createFoundationDataAccess, SCAN_TABLE_NAMES } from "./foundation-data-access.ts";
import { DYNAMO_TABLES } from "./tables.ts";

describe("createFoundationDataAccess", () => {
  it("lists production Scan tables and excludes SessionLogs", () => {
    expect(SCAN_TABLE_NAMES).toContain("Sessions");
    expect(SCAN_TABLE_NAMES).toContain("Users");
    expect(SCAN_TABLE_NAMES).not.toContain("SessionLogs");
    expect(SCAN_TABLE_NAMES).not.toContain("AuditLogs");
    expect(SCAN_TABLE_NAMES).not.toContain("RateLimits");
  });

  it("fails closed when a catalog table is missing", () => {
    const app = new App();
    const stack = new Stack(app, "Access");
    const bucket = new s3.Bucket(stack, "Archive");
    const tables: Record<string, dynamodb.Table> = {};
    expect(() => createFoundationDataAccess(stack, tables, bucket)).toThrow(
      "missing DynamoDB table definition",
    );

    const users = new dynamodb.Table(stack, "Users", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    });
    expect(() => createFoundationDataAccess(stack, { Users: users }, bucket)).toThrow(
      `missing DynamoDB table definition: ${DYNAMO_TABLES[1]?.name}`,
    );
  });
});
