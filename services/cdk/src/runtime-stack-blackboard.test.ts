import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

describe("required reporting runtime", () => {
  it("wires the durable session stream to the existing cron controller and scopes credentials to control-plane functions", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReportingTest",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReportingTest",
    });
    const data = Template.fromStack(foundation);
    const compute = Template.fromStack(runtime);
    data.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "ReportingTest-Sessions",
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
    });
    data.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "ReportingTest-WebhookDeliveries",
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: "state-dueAt" })]),
    });
    const functions = Object.values(compute.findResources("AWS::Lambda::Function")).filter(
      (fn) => fn.Properties?.Environment?.Variables?.HARNESS_BLACKBOARD_SSM_PARAM,
    );
    expect(functions).toHaveLength(3);
    expect(functions.map((fn) => fn.Properties?.Handler).toSorted()).toEqual([
      "index.cron",
      "index.rest",
      "index.websocket",
    ]);
    expect(functions.every((fn) => fn.Properties?.Runtime === "nodejs24.x")).toBe(true);
    expect(functions.every((fn) => !JSON.stringify(fn).includes("AGENT_BLACKBOARD_TOKEN"))).toBe(
      true,
    );
    compute.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 25,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      StartingPosition: "LATEST",
      BisectBatchOnFunctionError: true,
      EventSourceArn: Match.anyValue(),
    });
    compute.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "ssm:GetParameter",
              Resource: Match.objectLike({
                "Fn::Join": Match.arrayWith([
                  Match.arrayWith([Match.objectLike({ Ref: "HarnessBlackboardSsmParam" })]),
                ]),
              }),
            }),
          ]),
        },
      },
      3,
    );
    const streamPolicies = Object.values(compute.findResources("AWS::IAM::Policy")).filter(
      (policy) => JSON.stringify(policy).includes("dynamodb:GetRecords"),
    );
    expect(streamPolicies).toHaveLength(1);
    const streamRead = streamPolicies[0]!.Properties.PolicyDocument.Statement.find(
      (statement: { Action: string | string[] }) =>
        Array.isArray(statement.Action) && statement.Action.includes("dynamodb:GetRecords"),
    );
    expect(streamRead.Resource).toEqual({
      "Fn::ImportValue": expect.stringMatching(/Sessions.*StreamArn/),
    });
    data.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "ReportingTest-ReportingRepairCheckpoints",
      KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
    });
  });
});
