import { describe, expect, it } from "vitest";

import { deploymentConfig } from "./deployment-config.ts";

describe("deploymentConfig", () => {
  it("derives isolated environment names and defaults", () => {
    expect(
      deploymentConfig("deploy", {
        AWS_REGION: "us-west-2",
        HARNESS_DEPLOY_ENVIRONMENT: "production",
      }),
    ).toMatchObject({
      adminsSsmParam: "/auto-harness/production/harness-admins",
      foundationStackName: "AutoHarness-production-Foundation",
      publicBaseUrlSsmParam: "/auto-harness/production/public-base-url",
      removalPolicy: "retain",
      runtimeStackName: "AutoHarness-production-Runtime",
      tablePrefix: "AutoHarness-production",
      webStackName: "AutoHarness-production-Web",
    });
  });

  it("validates required and bounded configuration", () => {
    expect(() => deploymentConfig("deploy", {})).toThrow("HARNESS_DEPLOY_ENVIRONMENT");
    expect(() =>
      deploymentConfig("deploy", { AWS_REGION: "x", HARNESS_DEPLOY_ENVIRONMENT: "Bad" }),
    ).toThrow("lowercase");
    expect(() =>
      deploymentConfig("deploy", {
        AWS_REGION: "x",
        HARNESS_DEPLOY_ENVIRONMENT: "ok",
        HARNESS_DEPLOY_REMOVAL_POLICY: "remove",
      }),
    ).toThrow("retain or destroy");
    expect(() =>
      deploymentConfig("deploy", {
        HARNESS_DEPLOY_ENVIRONMENT: "ok",
      }),
    ).toThrow("AWS_REGION");
  });

  it("does not require a web origin for teardown", () => {
    expect(
      deploymentConfig("teardown", {
        AWS_DEFAULT_REGION: "us-east-1",
        HARNESS_DEPLOY_CONFIRM: "review",
        HARNESS_DEPLOY_ENVIRONMENT: "review",
      }),
    ).toMatchObject({ region: "us-east-1", teardownConfirmation: "review" });
  });

  it("parses purge confirmation and the SSM opt-in strictly", () => {
    expect(
      deploymentConfig("purge", {
        AWS_REGION: "us-west-2",
        HARNESS_DEPLOY_CONFIRM: "review",
        HARNESS_DEPLOY_ENVIRONMENT: "review",
        HARNESS_DEPLOY_PURGE_CONFIRM: "destroy-all-data-in-review",
        HARNESS_DEPLOY_PURGE_SSM: "1",
      }),
    ).toMatchObject({
      purgeConfirmation: "destroy-all-data-in-review",
      purgeSsmParameters: true,
      teardownConfirmation: "review",
    });

    // Unset or anything other than the literal "1" is treated as opt-out, not an error —
    // this is a deliberate default-safe opt-in, not a boolean parse.
    const unopted = deploymentConfig("purge", {
      AWS_REGION: "us-west-2",
      HARNESS_DEPLOY_ENVIRONMENT: "review",
      HARNESS_DEPLOY_PURGE_SSM: "true",
    });
    expect(unopted.purgeConfirmation).toBeUndefined();
    expect(unopted.purgeSsmParameters).toBe(false);
  });

  it('keeps access logs off unless explicitly opted in with the literal "1"', () => {
    const defaultOff = deploymentConfig("deploy", {
      AWS_REGION: "us-west-2",
      HARNESS_DEPLOY_ENVIRONMENT: "review",
    });
    expect(defaultOff.accessLogsEnabled).toBe(false);

    const optedIn = deploymentConfig("deploy", {
      AWS_REGION: "us-west-2",
      HARNESS_ACCESS_LOGS_ENABLED: "1",
      HARNESS_DEPLOY_ENVIRONMENT: "review",
    });
    expect(optedIn.accessLogsEnabled).toBe(true);

    const notOne = deploymentConfig("deploy", {
      AWS_REGION: "us-west-2",
      HARNESS_ACCESS_LOGS_ENABLED: "true",
      HARNESS_DEPLOY_ENVIRONMENT: "review",
    });
    expect(notOne.accessLogsEnabled).toBe(false);
  });

  it("accepts explicit account and parameter-name overrides", () => {
    expect(
      deploymentConfig("deploy", {
        AWS_ACCOUNT_ID: "123456789012",
        AWS_DEFAULT_REGION: "us-east-1",
        AWS_REGION: " ",
        HARNESS_ADMINS_SSM_PARAM: "/custom/admins",
        HARNESS_CURSOR_SECRET_SSM_PARAM: "/custom/cursor",
        HARNESS_DEPLOY_CONFIRM: "review",
        HARNESS_DEPLOY_ENVIRONMENT: "review",
        HARNESS_PUBLIC_BASE_URL_SSM_PARAM: "/custom/public-base-url",
        HARNESS_SESSION_SECRET_SSM_PARAM: "/custom/session",
      }),
    ).toMatchObject({
      accountId: "123456789012",
      adminsSsmParam: "/custom/admins",
      cursorSecretSsmParam: "/custom/cursor",
      publicBaseUrlSsmParam: "/custom/public-base-url",
      sessionSecretSsmParam: "/custom/session",
      teardownConfirmation: "review",
    });
  });
});
