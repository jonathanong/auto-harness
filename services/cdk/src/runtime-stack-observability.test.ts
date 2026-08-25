import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";
import { HTTP_THROTTLE, WEBSOCKET_THROTTLE } from "./runtime-observability.ts";

describe("runtime observability", () => {
  it("adds throttles and operational alarms, with access logs off by default", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);

    // Access logs require a one-time, account-level API Gateway CloudWatch Logs role
    // (scripts/bootstrap-apigateway-account.sh) this stack does not provision, so they
    // default off — see the enabled case below for accessLogsEnabled: true. The 3 log
    // groups present regardless are the rest/websocket/cron functions' own logGroup:
    // constructs (see functionLogGroup in runtime-stack.ts). RETAIN (not DESTROY) on every
    // one of them is the actual point of functionLogGroup: deleting or renaming a function's
    // construct must orphan its log group, not delete up to 14 days of application history.
    const functionLogGroups = Object.values(template.findResources("AWS::Logs::LogGroup"));
    expect(functionLogGroups).toHaveLength(3);
    for (const group of functionLogGroups) {
      expect(group.DeletionPolicy).toBe("Retain");
      expect(group.UpdateReplacePolicy).toBe("Retain");
      expect(group.Properties?.RetentionInDays).toBe(14);
    }
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AccessLogSettings: Match.absent(),
      DefaultRouteSettings: {
        DetailedMetricsEnabled: true,
        ThrottlingBurstLimit: HTTP_THROTTLE.burst,
        ThrottlingRateLimit: HTTP_THROTTLE.rate,
      },
      StageName: "$default",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AccessLogSettings: Match.absent(),
      DefaultRouteSettings: {
        DetailedMetricsEnabled: true,
        ThrottlingBurstLimit: WEBSOCKET_THROTTLE.burst,
        ThrottlingRateLimit: WEBSOCKET_THROTTLE.rate,
      },
      StageName: "prod",
    });

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
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).toContain("IntegrationError");
    expect(rendered).toContain("ExecutionError");
  });

  it("adds redacted access logs when accessLogsEnabled is set", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      accessLogsEnabled: true,
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);

    // 2 access-log groups (HTTP + WebSocket) plus the 3 always-present function log groups.
    // Disabling accessLogsEnabled later removes the access-log construct from the stack, and
    // deleting/renaming a function's construct removes its own log group; RETAIN on every one
    // of the 5 orphans the log group instead of deleting up to 14 days of history.
    const allLogGroups = Object.values(template.findResources("AWS::Logs::LogGroup"));
    expect(allLogGroups).toHaveLength(5);
    for (const group of allLogGroups) {
      expect(group.DeletionPolicy).toBe("Retain");
      expect(group.UpdateReplacePolicy).toBe("Retain");
      expect(group.Properties?.RetentionInDays).toBe(14);
    }
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
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).toContain("IntegrationError");
    expect(rendered).toContain("ExecutionError");
  });
});
