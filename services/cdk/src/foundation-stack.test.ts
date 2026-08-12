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

    template.resourceCountIs("AWS::DynamoDB::Table", 15);
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
    ).toHaveLength(17);
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
    const longestSafePrefix = "a".repeat(238);

    foundationTemplate({ tablePrefix: longestSafePrefix }).hasResourceProperties(
      "AWS::DynamoDB::Table",
      { TableName: `${longestSafePrefix}-ProviderAccounts` },
    );
    expect(() => foundationTemplate({ tablePrefix: `${longestSafePrefix}a` })).toThrow(
      "tablePrefix is too long",
    );
  });
});
