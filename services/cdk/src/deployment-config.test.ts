import { describe, expect, it } from "vitest";

import { deploymentConfig } from "./deployment-config.ts";

describe("deploymentConfig", () => {
  it("derives isolated environment names and defaults", () => {
    expect(
      deploymentConfig("deploy", {
        AWS_REGION: "us-west-2",
        HARNESS_DEPLOY_ENVIRONMENT: "production",
        HARNESS_DEPLOY_WEB_ORIGIN: "https://harness.example.com",
      }),
    ).toMatchObject({
      adminsSsmParam: "/auto-harness/production/harness-admins",
      foundationStackName: "AutoHarness-production-Foundation",
      removalPolicy: "retain",
      runtimeStackName: "AutoHarness-production-Runtime",
      tablePrefix: "AutoHarness-production",
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
        HARNESS_DEPLOY_WEB_ORIGIN: "https://example.test",
      }),
    ).toThrow("AWS_REGION");
    expect(() =>
      deploymentConfig("deploy", {
        AWS_REGION: "x",
        HARNESS_DEPLOY_ENVIRONMENT: "ok",
        HARNESS_DEPLOY_WEB_ORIGIN: "example.test/path",
      }),
    ).toThrow("absolute URL");
    for (const origin of ["https://example.test/path", "ftp://example.test"]) {
      expect(() =>
        deploymentConfig("deploy", {
          AWS_REGION: "x",
          HARNESS_DEPLOY_ENVIRONMENT: "ok",
          HARNESS_DEPLOY_WEB_ORIGIN: origin,
        }),
      ).toThrow("exact HTTP(S) origin");
    }
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
        HARNESS_DEPLOY_WEB_ORIGIN: "http://localhost:7421",
        HARNESS_SESSION_SECRET_SSM_PARAM: "/custom/session",
      }),
    ).toMatchObject({
      accountId: "123456789012",
      adminsSsmParam: "/custom/admins",
      cursorSecretSsmParam: "/custom/cursor",
      sessionSecretSsmParam: "/custom/session",
      teardownConfirmation: "review",
    });
  });
});
