import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

describe("AutoHarnessRuntimeStack", () => {
  it("synthesizes bounded REST, WebSocket, and scheduled Lambda infrastructure", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);

    template.resourceCountIs("AWS::Lambda::Function", 3);
    template.resourceCountIs("AWS::Events::Rule", 1);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 4);
    template.resourceCountIs("AWS::ApiGatewayV2::Stage", 2);
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ARCHIVE_BUCKET: Match.anyValue(),
          HARNESS_DDB_PREFIX: "ReviewRuntime",
          WS_API_ENDPOINT: Match.anyValue(),
        }),
      },
      Handler: "index.websocket",
      Runtime: "nodejs22.x",
      Timeout: 30,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          HARNESS_CURSOR_SECRET_SSM_PARAM: { Ref: "HarnessCursorSecretSsmParam" },
          WS_API_ENDPOINT: Match.anyValue(),
        }),
      },
      Handler: "index.cron",
      Runtime: "nodejs22.x",
      Timeout: 60,
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
      State: "ENABLED",
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue(), Id: Match.anyValue() })]),
    });
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      FunctionName: Match.anyValue(),
      Principal: "events.amazonaws.com",
      SourceArn: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ WS_API_ENDPOINT: Match.anyValue() }),
      },
      Handler: "index.rest",
    });
    template.resourcePropertiesCountIs(
      "AWS::ApiGatewayV2::Integration",
      {
        IntegrationMethod: "POST",
      },
      2,
    );
    const integrations = Object.values(template.findResources("AWS::ApiGatewayV2::Integration"));
    expect(integrations).toHaveLength(2);
    for (const integration of integrations) {
      expect(JSON.stringify(integration.Properties?.IntegrationUri)).toContain(":lambda:");
    }
    const functions = Object.values(template.findResources("AWS::Lambda::Function"));
    for (const fn of functions) {
      expect(fn.Properties?.Environment?.Variables?.ARCHIVE_BUCKET).toBeDefined();
      expect(fn.Properties?.Environment?.Variables?.HARNESS_CURSOR_SECRET_SSM_PARAM).toEqual({
        Ref: "HarnessCursorSecretSsmParam",
      });
    }
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    for (const role of roles) {
      expect(JSON.stringify(role.Properties?.ManagedPolicyArns)).toContain(
        "ArchiveDataAccessPolicy",
      );
    }
    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "execute-api:ManageConnections",
              Effect: "Allow",
              Resource: Match.anyValue(),
            }),
          ]),
        },
      },
      3,
    );
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      PendingWindowInDays: 7,
    });
    expect(
      Object.values(template.toJSON().Resources).find(
        (resource) => resource.Type === "AWS::KMS::Key",
      )?.DeletionPolicy,
    ).toBe("Retain");
    template.hasOutput("RestApiUrl", {});
    template.hasOutput("WebSocketUrl", {});
    expect(Object.keys(template.toJSON().Parameters)).toEqual(
      expect.arrayContaining([
        "HarnessAdminsSsmParam",
        "HarnessCursorSecretSsmParam",
        "HarnessSessionSecretSsmParam",
      ]),
    );
    // These parameters hold an SSM parameter *name*, not a secret value — unlike the
    // plaintext CfnParameters they replaced, none require a minimum secret length.
    const parameters = template.toJSON().Parameters as Record<
      string,
      { MinLength?: number; Type: string }
    >;
    for (const id of [
      "HarnessAdminsSsmParam",
      "HarnessSessionSecretSsmParam",
      "HarnessCursorSecretSsmParam",
    ]) {
      expect(parameters[id]?.Type).toBe("String");
      expect(parameters[id]?.MinLength).toBeUndefined();
    }

    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: "ssm:GetParameter", Effect: "Allow" }),
          ]),
        },
      },
      3,
    );
    // Scoped beyond the resource ARN: kms:ViaService restricts the grant to SSM calling
    // KMS on the Lambda's behalf, and the EncryptionContext:PARAMETER_ARN condition
    // restricts it to decrypting these three parameters specifically, not any
    // SecureString the account happens to encrypt under the same shared alias/aws/ssm key.
    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "kms:Decrypt",
              Effect: "Allow",
              Condition: {
                StringEquals: {
                  "kms:ViaService": Match.objectLike({
                    "Fn::Join": [
                      "",
                      Match.arrayWith([Match.stringLikeRegexp("^ssm\\."), ".amazonaws.com"]),
                    ],
                  }),
                  "kms:EncryptionContext:PARAMETER_ARN": Match.arrayWith([
                    Match.objectLike({
                      "Fn::Join": Match.arrayWith([
                        Match.arrayWith([Match.objectLike({ Ref: "HarnessAdminsSsmParam" })]),
                      ]),
                    }),
                    Match.objectLike({
                      "Fn::Join": Match.arrayWith([
                        Match.arrayWith([
                          Match.objectLike({ Ref: "HarnessSessionSecretSsmParam" }),
                        ]),
                      ]),
                    }),
                    Match.objectLike({
                      "Fn::Join": Match.arrayWith([
                        Match.arrayWith([Match.objectLike({ Ref: "HarnessCursorSecretSsmParam" })]),
                      ]),
                    }),
                  ]),
                },
              },
            }),
          ]),
        },
      },
      3,
    );
  });
});
