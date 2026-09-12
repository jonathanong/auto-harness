import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

describe("AutoHarnessRuntimeStack Slack application secret wiring", () => {
  it("gives only REST the parameter name and parameter-scoped SecureString access", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);

    const functions = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (fn) => fn.Properties?.Environment?.Variables?.HARNESS_SLACK_APP_SSM_PARAM,
    );
    expect(functions).toHaveLength(1);
    expect(functions[0]?.Properties?.Handler).toBe("index.rest");
    expect(functions[0]?.Properties?.Environment?.Variables?.HARNESS_SLACK_APP_SSM_PARAM).toEqual({
      Ref: "HarnessSlackAppSsmParam",
    });

    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "ssm:GetParameter",
              Effect: "Allow",
              Resource: Match.objectLike({
                "Fn::Join": Match.arrayWith([
                  Match.arrayWith([Match.objectLike({ Ref: "HarnessSlackAppSsmParam" })]),
                ]),
              }),
            }),
            Match.objectLike({
              Action: "kms:Decrypt",
              Condition: {
                StringEquals: {
                  "kms:EncryptionContext:PARAMETER_ARN": Match.objectLike({
                    "Fn::Join": Match.arrayWith([
                      Match.arrayWith([Match.objectLike({ Ref: "HarnessSlackAppSsmParam" })]),
                    ]),
                  }),
                  "kms:ViaService": Match.anyValue(),
                },
              },
              Effect: "Allow",
            }),
          ]),
        },
      },
      1,
    );
  });
});
