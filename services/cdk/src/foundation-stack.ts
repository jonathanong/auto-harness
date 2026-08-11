import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

import { DYNAMO_TABLES, type TableDef } from "./tables.ts";

export type FoundationStackProps = StackProps & {
  /** Physical table name prefix. Must match `HARNESS_DDB_PREFIX` at runtime. */
  tablePrefix?: string;
  /** Optional globally unique archive bucket name. Leave unset for a generated name. */
  archiveBucketName?: string;
  /** Defaults to RETAIN. DESTROY is intended only for disposable environments. */
  dataRemovalPolicy?: RemovalPolicy;
};

export type FoundationResources = {
  archiveBucket: s3.Bucket;
  archiveDataAccessPolicy: iam.ManagedPolicy;
  apiDataAccessPolicy: iam.ManagedPolicy;
  tables: Readonly<Record<string, dynamodb.Table>>;
};

const defaultTablePrefix = "AutoHarness";

function assertTablePrefix(prefix: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(prefix)) {
    throw new Error(
      "tablePrefix may contain only letters, numbers, dots, underscores, and hyphens",
    );
  }
}

function tableName(prefix: string, definition: TableDef): string {
  return `${prefix}-${definition.name}`;
}

function addIndexes(table: dynamodb.Table, definition: TableDef): void {
  for (const index of definition.gsis ?? []) {
    table.addGlobalSecondaryIndex({
      indexName: index.name,
      partitionKey: { name: index.partitionKey.name, type: dynamodb.AttributeType.STRING },
      ...(index.sortKey
        ? { sortKey: { name: index.sortKey.name, type: dynamodb.AttributeType.STRING } }
        : {}),
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}

function addOutput(
  stack: Stack,
  id: string,
  props: ConstructorParameters<typeof CfnOutput>[2],
): void {
  const output = new CfnOutput(stack, id, props);
  void output;
}

/**
 * The deployable persistence foundation only. It intentionally has no compute,
 * API Gateway, WebSocket, or scheduler resources.
 */
export class AutoHarnessFoundationStack extends Stack {
  readonly resources: FoundationResources;

  constructor(scope: Construct, id: string, props: FoundationStackProps = {}) {
    super(scope, id, props);

    const tablePrefix = props.tablePrefix ?? defaultTablePrefix;
    assertTablePrefix(tablePrefix);
    const removalPolicy = props.dataRemovalPolicy ?? RemovalPolicy.RETAIN;
    const tables: Record<string, dynamodb.Table> = {};

    for (const definition of DYNAMO_TABLES) {
      const table = new dynamodb.Table(this, definition.name, {
        tableName: tableName(tablePrefix, definition),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: definition.partitionKey.name, type: dynamodb.AttributeType.STRING },
        ...(definition.sortKey
          ? { sortKey: { name: definition.sortKey.name, type: dynamodb.AttributeType.STRING } }
          : {}),
        ...(definition.ttlAttribute ? { timeToLiveAttribute: definition.ttlAttribute } : {}),
        removalPolicy,
      });
      addIndexes(table, definition);
      tables[definition.name] = table;
      addOutput(this, `${definition.name}TableName`, {
        description: `Set TABLE_${definition.name.toUpperCase()} to this value where a per-table name is needed.`,
        value: table.tableName,
      });
    }

    const archiveBucket = new s3.Bucket(this, "SessionArchiveBucket", {
      ...(props.archiveBucketName ? { bucketName: props.archiveBucketName } : {}),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "ArchiveStorageTransitions",
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(90) },
          ],
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(90) },
          ],
        },
      ],
      versioned: true,
      removalPolicy,
    });
    archiveBucket.policy?.applyRemovalPolicy(removalPolicy);

    const tableResources = DYNAMO_TABLES.flatMap((definition) => {
      const table = tables[definition.name];
      return [table.tableArn, ...(definition.gsis?.length ? [`${table.tableArn}/index/*`] : [])];
    });
    const apiDataAccessPolicy = new iam.ManagedPolicy(this, "ApiDataAccessPolicy", {
      description:
        "Least-privilege DynamoDB data-plane access for a future Auto Harness API runtime.",
      statements: [
        new iam.PolicyStatement({
          actions: [
            "dynamodb:BatchWriteItem",
            "dynamodb:ConditionCheckItem",
            "dynamodb:DeleteItem",
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:UpdateItem",
          ],
          resources: tableResources,
        }),
      ],
    });
    const sessionLogs = tables.SessionLogs;
    const archiveDataAccessPolicy = new iam.ManagedPolicy(this, "ArchiveDataAccessPolicy", {
      description: "Least-privilege session-log archive access for a future archival runtime.",
      statements: [
        new iam.PolicyStatement({
          actions: ["dynamodb:Query"],
          resources: [sessionLogs.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ["s3:GetBucketLocation"],
          resources: [archiveBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: ["s3:AbortMultipartUpload", "s3:PutObject"],
          resources: [archiveBucket.arnForObjects("sessions/*")],
        }),
      ],
    });

    addOutput(this, "TablePrefix", {
      description:
        "Set HARNESS_DDB_PREFIX to this value for the current DynamoDB storage naming contract.",
      value: tablePrefix,
    });
    addOutput(this, "ArchiveBucketName", {
      description: "Set ARCHIVE_BUCKET to this value for future log archival workers.",
      value: archiveBucket.bucketName,
    });
    addOutput(this, "ArchiveBucketArn", { value: archiveBucket.bucketArn });
    addOutput(this, "ApiDataAccessPolicyArn", { value: apiDataAccessPolicy.managedPolicyArn });
    addOutput(this, "ArchiveDataAccessPolicyArn", {
      value: archiveDataAccessPolicy.managedPolicyArn,
    });

    this.resources = { archiveBucket, archiveDataAccessPolicy, apiDataAccessPolicy, tables };
  }
}
