import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

describe("AutoHarnessRuntimeStack", () => {
  it("synthesizes bounded REST and WebSocket Lambda infrastructure", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);

    template.resourceCountIs("AWS::Lambda::Function", 2);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 4);
    template.resourceCountIs("AWS::ApiGatewayV2::Stage", 2);
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
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
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "execute-api:ManageConnections",
            Effect: "Allow",
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
    });
    template.hasOutput("RestApiUrl", {});
    template.hasOutput("WebSocketUrl", {});
    expect(Object.keys(template.toJSON().Parameters)).toEqual(
      expect.arrayContaining(["HarnessAdmins", "HarnessSessionSecret", "WebOrigin"]),
    );
  });
});
