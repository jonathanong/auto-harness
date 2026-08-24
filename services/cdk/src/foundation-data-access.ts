import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

import { DYNAMO_TABLES } from "./tables.ts";

/**
 * Production Scan paths: catalog hydrate/list, auth hydrate, session/worktree/connection
 * snapshots, and webhook outbox listing. SessionLogs, AuditLogs, and lock/TTL tables are
 * Query/Get/Put only — do not grant Scan there.
 */
export const SCAN_TABLE_NAMES = [
  "Users",
  "Repositories",
  "Worktrees",
  "Sessions",
  "SessionDrains",
  "Schedules",
  "Connections",
  "Archives",
  "HostInventories",
  "Providers",
  "ProviderAccounts",
  "Commands",
  "SessionUsage",
  "WebhookDeliveries",
] as const;

const ITEM_ACTIONS = [
  "dynamodb:BatchGetItem",
  "dynamodb:BatchWriteItem",
  "dynamodb:ConditionCheckItem",
  "dynamodb:DeleteItem",
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:Query",
  "dynamodb:TransactGetItems",
  "dynamodb:TransactWriteItems",
  "dynamodb:UpdateItem",
];

function requireTable(
  tables: Readonly<Record<string, dynamodb.Table>>,
  name: string,
): dynamodb.Table {
  const table = tables[name];
  if (!table) throw new Error(`missing DynamoDB table definition: ${name}`);
  return table;
}

function itemResources(tables: Readonly<Record<string, dynamodb.Table>>): string[] {
  return DYNAMO_TABLES.flatMap((definition) => {
    const table = requireTable(tables, definition.name);
    return [table.tableArn, ...(definition.gsis?.length ? [`${table.tableArn}/index/*`] : [])];
  });
}

function scanResources(tables: Readonly<Record<string, dynamodb.Table>>): string[] {
  return SCAN_TABLE_NAMES.map((name) => requireTable(tables, name).tableArn);
}

export function createFoundationDataAccess(
  scope: Construct,
  tables: Readonly<Record<string, dynamodb.Table>>,
  archiveBucket: s3.Bucket,
): { apiDataAccessPolicy: iam.ManagedPolicy; archiveDataAccessPolicy: iam.ManagedPolicy } {
  // AWS IAM cannot update a managed policy's Description in place, so CloudFormation treats any
  // change to this string as a replacement. Runtime imports these ARNs via a hard CloudFormation
  // export, which blocks the replacement mid-deploy — do not edit these strings without first
  // migrating Runtime off the export (e.g. SSM Parameter passing) to decouple the two stacks.
  const apiDataAccessPolicy = new iam.ManagedPolicy(scope, "ApiDataAccessPolicy", {
    description:
      "Least-privilege DynamoDB data-plane access for a future Auto Harness API runtime.",
    statements: [
      new iam.PolicyStatement({ actions: ITEM_ACTIONS, resources: itemResources(tables) }),
      new iam.PolicyStatement({ actions: ["dynamodb:Scan"], resources: scanResources(tables) }),
    ],
  });
  const archiveDataAccessPolicy = new iam.ManagedPolicy(scope, "ArchiveDataAccessPolicy", {
    description: "Least-privilege session-log archive access for a future archival runtime.",
    statements: [
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [archiveBucket.arnForObjects("sessions/*")],
      }),
    ],
  });
  return { apiDataAccessPolicy, archiveDataAccessPolicy };
}
