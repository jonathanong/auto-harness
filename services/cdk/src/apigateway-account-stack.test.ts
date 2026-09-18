import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ApiGatewayAccountStack } from "./apigateway-account-stack.ts";

describe("ApiGatewayAccountStack", () => {
  it("provisions a retained account-wide CloudWatch Logs role", () => {
    const app = new App();
    const stack = new ApiGatewayAccountStack(app, "ApiGatewayAccount");
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::IAM::Role", 1);
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Principal: { Service: "apigateway.amazonaws.com" },
          }),
        ],
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          "Fn::Join": Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp("AmazonAPIGatewayPushToCloudWatchLogs")]),
          ]),
        }),
      ]),
    });

    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    expect(roles).toHaveLength(1);
    const [role] = roles;
    expect(role?.DeletionPolicy).toBe("Retain");
    expect(role?.UpdateReplacePolicy).toBe("Retain");

    template.resourceCountIs("AWS::ApiGateway::Account", 1);
    const accounts = Object.values(template.findResources("AWS::ApiGateway::Account"));
    expect(accounts).toHaveLength(1);
    const [account] = accounts;
    expect(account?.DeletionPolicy).toBe("Retain");
    expect(account?.UpdateReplacePolicy).toBe("Retain");
    expect(account?.Properties?.CloudWatchRoleArn).toBeDefined();
  });
});
