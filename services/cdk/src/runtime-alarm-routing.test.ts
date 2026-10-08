import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

function runtimeTemplate(
  options: { alarmsEnabled?: boolean; alarmEmails?: readonly string[] } = {},
): Template {
  const app = new App();
  const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
    tablePrefix: "AlarmRuntime",
  });
  const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
    foundation: foundation.resources,
    tablePrefix: "AlarmRuntime",
    ...(options.alarmsEnabled !== undefined ? { alarmsEnabled: options.alarmsEnabled } : {}),
    ...(options.alarmEmails ? { alarmEmails: options.alarmEmails } : {}),
  });
  return Template.fromStack(runtime);
}

/** The single logical id of the one SNS topic the runtime stack creates. */
function topicLogicalId(template: Template): string {
  const topics = Object.keys(template.findResources("AWS::SNS::Topic"));
  expect(topics).toHaveLength(1);
  return topics[0] as string;
}

describe("runtime alarm routing", () => {
  it("omits alarms, topic, and output by default", () => {
    const template = runtimeTemplate();
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    template.resourceCountIs("AWS::SNS::Topic", 0);
    expect(Object.keys(template.findOutputs("AlarmTopicArn"))).toEqual([]);
  });

  it("gives every retained alarm an action pointing at the one topic", () => {
    const template = runtimeTemplate({ alarmsEnabled: true });
    const topic = topicLogicalId(template);
    const alarms = Object.entries(template.findResources("AWS::CloudWatch::Alarm"));

    expect(alarms).toHaveLength(7);
    const alarmIds = alarms.map(([logicalId]) => logicalId.replace(/[A-F0-9]{8}$/u, "")).toSorted();
    expect(alarmIds).toEqual(
      [
        "CronFunctionErrors",
        "HttpApi5xx",
        "InfrastructureRetryExhausted",
        "QueueAge",
        "RestFunctionErrors",
        "WebSocketApiErrors",
        "WebSocketFunctionErrors",
      ].toSorted(),
    );
    for (const [logicalId, alarm] of alarms) {
      expect(alarm.Properties?.AlarmActions, `${logicalId} has no AlarmActions`).toEqual([
        { Ref: topic },
      ]);
    }
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).toContain("InfrastructureRetryExhausted");
    expect(rendered).toContain("QueueAgeSeconds");
    for (const recoverable of [
      "AssignmentFailures",
      "AckTimeouts",
      "StaleHosts",
      "Cooldowns",
      "LogDrops",
      "LogSeqGaps",
    ]) {
      expect(rendered).not.toContain(recoverable);
    }
  });

  it("publishes the topic ARN when enabled without email subscriptions", () => {
    const template = runtimeTemplate({ alarmsEnabled: true });
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 0);
    expect(Object.keys(template.findOutputs("AlarmTopicArn"))).toEqual(["AlarmTopicArn"]);
  });

  it("denies publishing over plaintext HTTP", () => {
    const rendered = JSON.stringify(runtimeTemplate({ alarmsEnabled: true }).toJSON());

    // enforceSSL renders as a topic policy denying requests without SecureTransport.
    expect(rendered).toContain("aws:SecureTransport");
  });

  it("subscribes each configured address, and keeps every alarm routed", () => {
    const template = runtimeTemplate({ alarmEmails: ["ops@example.com", "oncall@example.com"] });

    template.resourceCountIs("AWS::CloudWatch::Alarm", 7);
    template.resourceCountIs("AWS::SNS::Subscription", 2);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Endpoint: "ops@example.com",
      Protocol: "email",
    });
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Endpoint: "oncall@example.com",
      Protocol: "email",
    });
    const topic = topicLogicalId(template);
    for (const alarm of Object.values(template.findResources("AWS::CloudWatch::Alarm"))) {
      expect(alarm.Properties?.AlarmActions).toEqual([{ Ref: topic }]);
    }
  });

  it("routes alarms to one shared topic rather than one topic per alarm", () => {
    const template = runtimeTemplate({ alarmEmails: ["ops@example.com"] });

    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 1);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 7);
  });
});
