import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

function runtimeTemplate(alarmEmails?: readonly string[]): Template {
  const app = new App();
  const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
    tablePrefix: "AlarmRuntime",
  });
  const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
    foundation: foundation.resources,
    tablePrefix: "AlarmRuntime",
    ...(alarmEmails ? { alarmEmails } : {}),
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
  it("gives every alarm an action pointing at the one topic", () => {
    const template = runtimeTemplate();
    const topic = topicLogicalId(template);
    const alarms = Object.entries(template.findResources("AWS::CloudWatch::Alarm"));

    // Asserted over *every* alarm rather than a list of names, so a fourteenth alarm added
    // later cannot quietly ship unrouted. Before this existed all 13 had no action at all:
    // they changed state and notified nobody, which is the same as having no alarms.
    expect(alarms).toHaveLength(13);
    for (const [logicalId, alarm] of alarms) {
      expect(alarm.Properties?.AlarmActions, `${logicalId} has no AlarmActions`).toEqual([
        { Ref: topic },
      ]);
    }
  });

  it("creates the topic and publishes its ARN even with no subscribers configured", () => {
    const template = runtimeTemplate();

    // The topic is unconditional on purpose: subscribing is then one `aws sns subscribe`
    // against this output, not a code change and a redeploy.
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 0);
    expect(Object.keys(template.findOutputs("AlarmTopicArn"))).toEqual(["AlarmTopicArn"]);
  });

  it("denies publishing over plaintext HTTP", () => {
    const rendered = JSON.stringify(runtimeTemplate().toJSON());

    // enforceSSL renders as a topic policy denying requests without SecureTransport.
    expect(rendered).toContain("aws:SecureTransport");
  });

  it("subscribes each configured address, and keeps every alarm routed", () => {
    const template = runtimeTemplate(["ops@example.com", "oncall@example.com"]);

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
    const template = runtimeTemplate(["ops@example.com"]);

    // 13 topics would mean 13 subscription confirmations for one environment.
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 1);
  });
});
