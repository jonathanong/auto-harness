/* eslint-disable max-lines -- one synthesized foundation template covers the complete resource catalog. */
import { App, RemovalPolicy } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";

function foundationTemplate(
  props: ConstructorParameters<typeof AutoHarnessFoundationStack>[2] = {},
) {
  const app = new App();
  const stack = new AutoHarnessFoundationStack(app, "Foundation", props);
  return Template.fromStack(stack);
}

describe("AutoHarnessFoundationStack", () => {
  it("synthesizes every current durable table, archive bucket, outputs, and only foundation resources", () => {
    const template = foundationTemplate();

    template.resourceCountIs("AWS::DynamoDB::Table", 22);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "AutoHarness-SessionDrains",
      KeySchema: [
        { AttributeName: "scopeKey", KeyType: "HASH" },
        { AttributeName: "recordKey", KeyType: "RANGE" },
      ],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      TableName: "AutoHarness-SessionLogs",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      KeySchema: [
        { AttributeName: "sessionId", KeyType: "HASH" },
        { AttributeName: "timestampSeq", KeyType: "RANGE" },
      ],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "AutoHarness-Sessions",
      GlobalSecondaryIndexes: Match.arrayWith([
        {
          IndexName: "statusShard-createdAt",
          KeySchema: [
            { AttributeName: "statusShard", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: "repositoryId-createdAt",
          KeySchema: [
            { AttributeName: "repositoryId", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ]),
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "AutoHarness-AuditLogs",
      KeySchema: [
        { AttributeName: "scope", KeyType: "HASH" },
        { AttributeName: "timestampId", KeyType: "RANGE" },
      ],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "AutoHarness-RateLimits",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      KeySchema: [{ AttributeName: "bucketKey", KeyType: "HASH" }],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "AutoHarness-SessionUsage",
      KeySchema: [
        { AttributeName: "sessionId", KeyType: "HASH" },
        { AttributeName: "usageKey", KeyType: "RANGE" },
      ],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "AutoHarness-SessionUsageKinds",
      KeySchema: [{ AttributeName: "sessionAttempt", KeyType: "HASH" }],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      TableName: "AutoHarness-Integrations",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      TableName: "AutoHarness-NotificationDeliveries",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "status-nextAttemptAt",
          KeySchema: [
            { AttributeName: "status", KeyType: "HASH" },
            { AttributeName: "nextAttemptAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      TableName: "AutoHarness-WebhookDeliveries",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: Match.arrayWith([
        {
          IndexName: "state-dueAt",
          KeySchema: [
            { AttributeName: "state", KeyType: "HASH" },
            { AttributeName: "dueAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ]),
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [
          {
            Id: "ArchiveStorageTransitions",
            Status: "Enabled",
            Transitions: [
              { StorageClass: "STANDARD_IA", TransitionInDays: 30 },
              { StorageClass: "GLACIER", TransitionInDays: 90 },
            ],
            NoncurrentVersionTransitions: [
              { StorageClass: "STANDARD_IA", TransitionInDays: 30 },
              { StorageClass: "GLACIER", TransitionInDays: 90 },
            ],
          },
        ],
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
    template.hasResource("AWS::S3::BucketPolicy", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Condition: { Bool: { "aws:SecureTransport": "false" } },
              Effect: "Deny",
            }),
          ]),
        },
      },
    });
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:Query", "dynamodb:UpdateItem"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "dynamodb:Query", Effect: "Allow" }),
          Match.objectLike({ Action: Match.arrayWith(["s3:PutObject"]), Effect: "Allow" }),
        ]),
      },
    });
    template.hasOutput("TablePrefix", { Value: "AutoHarness" });
    template.hasOutput("ArchiveBucketName", {});
    template.hasOutput("ApiDataAccessPolicyArn", {});
    template.hasOutput("IntegrationKeyArn", {});
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      PendingWindowInDays: 7,
    });
    template.resourceCountIs("AWS::Lambda::Function", 0);
    template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    template.resourceCountIs("AWS::Events::Rule", 0);
  });

  it("allows disposable-environment retention and explicit physical names", () => {
    const template = foundationTemplate({
      archiveBucketName: "review-20-cdk-foundation-archives",
      dataRemovalPolicy: RemovalPolicy.DESTROY,
      tablePrefix: "Review20",
    });
    const json = template.toJSON() as { Resources: Record<string, { DeletionPolicy?: string }> };

    template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "Review20-Users" });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "review-20-cdk-foundation-archives",
    });
    expect(
      Object.values(json.Resources).filter((resource) => resource.DeletionPolicy === "Delete"),
    ).toHaveLength(25);
    expect(
      Object.values(json.Resources).filter(
        (resource) => resource.Type === "AWS::CloudFormation::CustomResource",
      ),
    ).toHaveLength(0);
    template.resourceCountIs("AWS::Lambda::Function", 0);
  });

  it("rejects an unsafe table prefix", () => {
    expect(() => foundationTemplate({ tablePrefix: "unsafe/prefix" })).toThrow("tablePrefix");
  });

  it("accepts the longest safe table prefix and rejects the next character", () => {
    const longestSafePrefix = "a".repeat(232);

    foundationTemplate({ tablePrefix: longestSafePrefix }).hasResourceProperties(
      "AWS::DynamoDB::Table",
      { TableName: `${longestSafePrefix}-NotificationDeliveries` },
    );
    expect(() => foundationTemplate({ tablePrefix: `${longestSafePrefix}a` })).toThrow(
      "tablePrefix is too long",
    );
  });
});
