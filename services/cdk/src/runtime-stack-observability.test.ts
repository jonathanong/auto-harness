import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";
import { HTTP_THROTTLE, WEBSOCKET_THROTTLE } from "./runtime-observability.ts";

describe("runtime observability", () => {
  it("adds redacted access logs, throttles, and operational alarms", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);

    template.resourceCountIs("AWS::Logs::LogGroup", 2);
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AccessLogSettings: Match.objectLike({
        Format: Match.stringLikeRegexp("requestId"),
      }),
      DefaultRouteSettings: {
        DetailedMetricsEnabled: true,
        ThrottlingBurstLimit: HTTP_THROTTLE.burst,
        ThrottlingRateLimit: HTTP_THROTTLE.rate,
      },
      StageName: "$default",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AccessLogSettings: Match.objectLike({
        Format: Match.stringLikeRegexp("connectionId"),
      }),
      DefaultRouteSettings: {
        DetailedMetricsEnabled: true,
        ThrottlingBurstLimit: WEBSOCKET_THROTTLE.burst,
        ThrottlingRateLimit: WEBSOCKET_THROTTLE.rate,
      },
      StageName: "prod",
    });

    const stages = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"));
    for (const stage of stages) {
      const format = String(stage.Properties?.AccessLogSettings?.Format ?? "");
      expect(format).not.toContain("querystring");
      expect(format).not.toContain("header");
      expect(format).not.toContain("authorizer");
    }

    template.resourceCountIs("AWS::CloudWatch::Alarm", 11);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "QueueAgeSeconds",
      Namespace: "AutoHarness",
      Threshold: 1800,
      TreatMissingData: "notBreaching",
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "LogDrops",
      Namespace: "AutoHarness",
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      Namespace: "AWS/Lambda",
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "5xx",
      Namespace: "AWS/ApiGateway",
    });
  });
});
