import { describe, expect, it } from "vitest";

import { deploymentConfig } from "./deployment-config.ts";
import { cdkContext } from "./deployment-support.ts";

const env = {
  AWS_REGION: "us-west-2",
  HARNESS_DEPLOY_ENVIRONMENT: "review",
};

function contextPairs(args: string[]): string[] {
  return args.flatMap((argument, index) => (argument === "-c" ? [args[index + 1] ?? ""] : []));
}

describe("CDK deployment context", () => {
  it("forwards an explicit alarms opt-in", () => {
    const config = deploymentConfig("deploy", { ...env, HARNESS_DEPLOY_ALARMS: "true" });
    const args = cdkContext(config);
    expect(contextPairs(args)).toEqual([
      "stackName=AutoHarness-review-Foundation",
      "runtimeStackName=AutoHarness-review-Runtime",
      "webStackName=AutoHarness-review-Web",
      "tablePrefix=AutoHarness-review",
      "removalPolicy=retain",
      "accessLogsEnabled=false",
      "alarmsEnabled=true",
      "sessionPriorityIndexStage=both",
      "sessionCreatedOrderIndexStage=status",
      "sessionRetentionIndexStage=status",
    ]);
    expect(args.filter((argument) => argument === "-c")).toHaveLength(contextPairs(args).length);
  });

  it("forwards the alarms opt-out when no subscriber enables alarms", () => {
    const config = deploymentConfig("deploy", env);
    const args = cdkContext(config);
    expect(contextPairs(args)).toContain("alarmsEnabled=false");
    expect(args.filter((argument) => argument === "-c")).toHaveLength(contextPairs(args).length);
  });

  it("email subscribers enable alarms even when the explicit flag is false", () => {
    const config = deploymentConfig("deploy", {
      ...env,
      HARNESS_DEPLOY_ALARMS: "false",
      HARNESS_DEPLOY_ALARM_EMAILS: "ops@example.com",
    });
    const args = cdkContext(config);
    expect(contextPairs(args)).toEqual([
      "stackName=AutoHarness-review-Foundation",
      "runtimeStackName=AutoHarness-review-Runtime",
      "webStackName=AutoHarness-review-Web",
      "tablePrefix=AutoHarness-review",
      "removalPolicy=retain",
      "accessLogsEnabled=false",
      "alarmsEnabled=true",
      "sessionPriorityIndexStage=both",
      "sessionCreatedOrderIndexStage=status",
      "sessionRetentionIndexStage=status",
      "alarmEmails=ops@example.com",
    ]);
    expect(args.filter((argument) => argument === "-c")).toHaveLength(contextPairs(args).length);
  });
});
