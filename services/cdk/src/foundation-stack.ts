import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

import { createFoundationDataAccess } from "./foundation-data-access.ts";
import { DYNAMO_TABLES, type TableDef } from "./tables.ts";

export type SessionPriorityIndexStage = "status" | "both";
export type SessionCreatedOrderIndexStage = "none" | "status";

type FoundationStackProps = StackProps & {
  /** Physical table name prefix. Must match `HARNESS_DDB_PREFIX` at runtime. */
  tablePrefix?: string;
  /** Optional globally unique archive bucket name. Leave unset for a generated name. */
  archiveBucketName?: string;
  /** Defaults to RETAIN. DESTROY is intended only for disposable environments. */
  dataRemovalPolicy?: RemovalPolicy;
  /** Existing tables must add Dynamo GSIs in separate CloudFormation updates. */
  sessionPriorityIndexStage?: SessionPriorityIndexStage;
  /** Existing tables add the created-order GSI after the priority-index rollout. */
  sessionCreatedOrderIndexStage?: SessionCreatedOrderIndexStage;
  /**
   * Purge-only: pins a named table's synthesized GSIs to exactly this live set, so a
   * deletion retarget makes no index changes regardless of how far that table has drifted
   * from the catalog. A table absent here keeps its full (possibly staged) definition — it
   * either isn't restricted or doesn't exist yet, and a fresh CREATE can add every GSI in
   * one call.
   */
  existingGsiNamesByTable?: Readonly<Record<string, readonly string[]>>;
};

export type FoundationResources = {
  archiveBucket: s3.Bucket;
  archiveDataAccessPolicy: iam.ManagedPolicy;
  apiDataAccessPolicy: iam.ManagedPolicy;
  integrationKey: kms.Key;
  tables: Readonly<Record<string, dynamodb.Table>>;
};

const defaultTablePrefix = "AutoHarness";
const maxDynamoTableNameLength = 255;
const longestCatalogTableNameLength = Math.max(
  ...DYNAMO_TABLES.map((definition) => definition.name.length),
);

function assertTablePrefix(prefix: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(prefix)) {
    throw new Error(
      "tablePrefix may contain only letters, numbers, dots, underscores, and hyphens",
    );
  }
  if (prefix.length + 1 + longestCatalogTableNameLength > maxDynamoTableNameLength) {
    throw new Error("tablePrefix is too long for generated DynamoDB table names");
  }
}

function tableName(prefix: string, definition: TableDef): string {
  return `${prefix}-${definition.name}`;
}

function stagedTables(
  priorityStage: SessionPriorityIndexStage,
  createdOrderStage: SessionCreatedOrderIndexStage,
  existingGsiNamesByTable?: Readonly<Record<string, readonly string[]>>,
): readonly TableDef[] {
  return DYNAMO_TABLES.map((definition) => {
    // Narrowing on the early return (rather than `let gsis = definition.gsis` unconditionally)
    // keeps `gsis` typed as a concrete array below, not `Array | undefined` — required under
    // exactOptionalPropertyTypes for the `{ ...definition, gsis }` spread further down.
    if (!definition.gsis) return definition;
    let gsis = definition.gsis;
    if (definition.name === "Sessions") {
      gsis = gsis.filter(
        (index) =>
          (priorityStage !== "status" || index.name !== "statusShard-repositoryPriorityOrder") &&
          (createdOrderStage !== "none" || index.name !== "statusShard-createdOrder"),
      );
    }
    // Purge's deletion retarget passes this so every restricted table's synthesized GSIs
    // match what's already live exactly — no create/delete, only the DeletionPolicy flip.
    const liveNames = existingGsiNamesByTable?.[definition.name];
    if (liveNames) {
      const live = new Set(liveNames);
      gsis = gsis.filter((index) => live.has(index.name));
    }
    return gsis === definition.gsis ? definition : { ...definition, gsis };
  });
}

function addIndexes(table: dynamodb.Table, definition: TableDef): void {
  for (const index of definition.gsis ?? []) {
    table.addGlobalSecondaryIndex({
      indexName: index.name,
      partitionKey: { name: index.partitionKey.name, type: dynamodb.AttributeType.STRING },
      ...(index.sortKey
        ? { sortKey: { name: index.sortKey.name, type: dynamodb.AttributeType.STRING } }
        : {}),
      projectionType:
        index.projectionType === "KEYS_ONLY"
          ? dynamodb.ProjectionType.KEYS_ONLY
          : dynamodb.ProjectionType.ALL,
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
    const definitions = stagedTables(
      props.sessionPriorityIndexStage ?? "both",
      props.sessionCreatedOrderIndexStage ?? "status",
      props.existingGsiNamesByTable,
    );
    const tables: Record<string, dynamodb.Table> = {};

    for (const definition of definitions) {
      const table = new dynamodb.Table(this, definition.name, {
        tableName: tableName(tablePrefix, definition),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: definition.partitionKey.name, type: dynamodb.AttributeType.STRING },
        ...(definition.sortKey
          ? { sortKey: { name: definition.sortKey.name, type: dynamodb.AttributeType.STRING } }
          : {}),
        ...(definition.ttlAttribute ? { timeToLiveAttribute: definition.ttlAttribute } : {}),
        deletionProtection: removalPolicy === RemovalPolicy.RETAIN,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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
    const integrationKey = new kms.Key(this, "IntegrationKey", {
      description: "Encrypts Auto Harness integration credentials.",
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
    });
    integrationKey.applyRemovalPolicy(removalPolicy);

    const { apiDataAccessPolicy, archiveDataAccessPolicy } = createFoundationDataAccess(
      this,
      tables,
      archiveBucket,
    );

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
    addOutput(this, "IntegrationKeyArn", { value: integrationKey.keyArn });
    addOutput(this, "ArchiveDataAccessPolicyArn", {
      value: archiveDataAccessPolicy.managedPolicyArn,
    });

    this.resources = {
      archiveBucket,
      archiveDataAccessPolicy,
      apiDataAccessPolicy,
      integrationKey,
      tables,
    };
  }
}
