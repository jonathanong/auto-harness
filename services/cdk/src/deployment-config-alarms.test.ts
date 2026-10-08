import { describe, expect, it } from "vitest";

import { deploymentConfig } from "./deployment-config.ts";

const base = { AWS_REGION: "us-west-2", HARNESS_DEPLOY_ENVIRONMENT: "review" };

describe("deploymentConfig alarm settings", () => {
  it("opts in only by exact true or a non-empty subscriber list", () => {
    expect(deploymentConfig("deploy", base)).toMatchObject({
      alarmsEnabled: false,
      alarmEmails: [],
    });
    for (const value of ["TRUE", " true "]) {
      expect(
        deploymentConfig("deploy", { ...base, HARNESS_DEPLOY_ALARMS: value }).alarmsEnabled,
      ).toBe(false);
    }
    expect(
      deploymentConfig("deploy", { ...base, HARNESS_DEPLOY_ALARMS: "true" }).alarmsEnabled,
    ).toBe(true);
    expect(
      deploymentConfig("deploy", { ...base, HARNESS_DEPLOY_ALARM_EMAILS: "   " }).alarmEmails,
    ).toEqual([]);
    expect(
      deploymentConfig("deploy", {
        ...base,
        HARNESS_DEPLOY_ALARM_EMAILS: " ops@example.com , oncall@example.com ,",
      }),
    ).toMatchObject({
      alarmsEnabled: true,
      alarmEmails: ["ops@example.com", "oncall@example.com"],
    });
    expect(
      deploymentConfig("deploy", {
        ...base,
        HARNESS_DEPLOY_ALARM_EMAILS: "ops@example.com,ops@example.com",
      }).alarmEmails,
    ).toEqual(["ops@example.com"]);
  });

  it("fails the deploy on malformed email addresses", () => {
    for (const bad of ["nope", "no-at-sign.example.com", "missing@tld", "a b@example.com"]) {
      expect(() =>
        deploymentConfig("deploy", { ...base, HARNESS_DEPLOY_ALARM_EMAILS: bad }),
      ).toThrow("HARNESS_DEPLOY_ALARM_EMAILS");
    }
    expect(() =>
      deploymentConfig("deploy", {
        ...base,
        HARNESS_DEPLOY_ALARM_EMAILS: "ops@example.com,nope",
      }),
    ).toThrow("nope");
  });
});
