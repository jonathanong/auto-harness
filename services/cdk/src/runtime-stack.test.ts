/* eslint-disable max-lines -- one synthesized runtime template covers REST, WebSocket, and cron. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, sep } from "node:path";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

describe("AutoHarnessRuntimeStack", () => {
  it("keeps the S3 presigner resolvable inside every synthesized Lambda asset", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const assembly = app.synth();
    const manifest = JSON.parse(
      readFileSync(join(assembly.directory, `${runtime.artifactId}.assets.json`), "utf8"),
    ) as { files?: Record<string, { source?: { path?: string } }> };
    const assets = Object.values(manifest.files ?? {})
      .map((asset) => asset.source?.path)
      .filter((path): path is string => path !== undefined)
      .map((path) => ({ path: isAbsolute(path) ? path : join(assembly.directory, path) }))
      .filter((asset) => existsSync(join(asset.path, "index.js")));

    expect(assets).not.toHaveLength(0);
    for (const asset of assets) {
      const resolved = createRequire(join(asset.path, "index.js")).resolve(
        "@aws-sdk/s3-request-presigner",
      );
      expect(resolved.startsWith(`${asset.path}${sep}node_modules${sep}`)).toBe(true);
    }
  });

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

    template.resourceCountIs("AWS::Lambda::Function", 4);
    template.resourcePropertiesCountIs("AWS::Logs::LogGroup", { RetentionInDays: 14 }, 4);
    // Each function must be wired to its own explicit logGroup: construct (see
    // functionLogGroup in runtime-stack.ts), not left to the deprecated logRetention path.
    // No Custom::LogRetention provider means the deprecated path is gone, not merely unused.
    template.resourceCountIs("Custom::LogRetention", 0);
    template.resourcePropertiesCountIs(
      "AWS::Lambda::Function",
      { LoggingConfig: { LogGroup: Match.anyValue() } },
      4,
    );
    template.resourceCountIs("AWS::Events::Rule", 1);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 4);
    template.resourceCountIs("AWS::ApiGatewayV2::Stage", 2);
    template.resourceCountIs("AWS::KMS::Key", 0);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          HARNESS_DDB_PREFIX: "ReviewRuntime",
          HARNESS_METRIC_ENVIRONMENT: "ReviewRuntime",
          NODE_ENV: "production",
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
        Variables: Match.objectLike({
          ASSIGNMENT_FUNCTION_NAME: Match.anyValue(),
          HARNESS_HYDRATE_CATALOGS: "false",
          HARNESS_SLACK_APP_SSM_PARAM: { Ref: "HarnessSlackAppSsmParam" },
          WS_API_ENDPOINT: Match.anyValue(),
        }),
      },
      Handler: "index.rest",
    });
    template.resourcePropertiesCountIs(
      "AWS::Lambda::Function",
      { Environment: { Variables: Match.objectLike({ HARNESS_HYDRATE_CATALOGS: "false" }) } },
      1,
    );
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerPayloadFormatVersion: "2.0",
      AuthorizerResultTtlInSeconds: 0,
      AuthorizerType: "REQUEST",
      EnableSimpleResponses: true,
      IdentitySource: ["$request.header.X-Auto-Harness-Ingress-Token"],
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      AuthorizationType: "CUSTOM",
      AuthorizerId: Match.anyValue(),
      RouteKey: "$default",
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
    const functions = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (fn) => fn.Properties?.Environment?.Variables?.HARNESS_DDB_PREFIX,
    );
    expect(functions).toHaveLength(3);
    const rest = functions.find((fn) => fn.Properties?.Handler === "index.rest");
    expect(
      rest?.Properties?.Environment?.Variables?.HARNESS_CLOUDFRONT_INGRESS_TOKEN,
    ).toBeUndefined();
    const archiveFunctions = functions.filter(
      (fn) => fn.Properties?.Environment?.Variables?.ARCHIVE_BUCKET,
    );
    expect(archiveFunctions).toHaveLength(2);
    expect(
      functions
        .filter((fn) => fn.Properties?.Handler === "index.websocket")
        .map((fn) => fn.Properties?.Environment?.Variables?.ARCHIVE_BUCKET),
    ).toEqual([undefined]);
    for (const fn of functions) {
      expect(fn.Properties?.Environment?.Variables?.NODE_ENV).toBe("production");
      expect(fn.Properties?.Environment?.Variables?.HARNESS_CURSOR_SECRET_SSM_PARAM).toEqual({
        Ref: "HarnessCursorSecretSsmParam",
      });
      expect(fn.Properties?.Environment?.Variables?.HARNESS_API_SENTRY_DSN).toBeUndefined();
    }
    const roles = Object.values(template.findResources("AWS::IAM::Role")).filter((role) =>
      JSON.stringify(role.Properties?.ManagedPolicyArns ?? []).includes("ArchiveDataAccessPolicy"),
    );
    expect(roles).toHaveLength(2);
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
    template.hasOutput("RestApiUrl", {});
    template.hasOutput("WebSocketUrl", {});
    expect(Object.keys(template.toJSON().Parameters)).toEqual(
      expect.arrayContaining([
        "HarnessAdminsSsmParam",
        "HarnessCursorSecretSsmParam",
        "HarnessSessionSecretSsmParam",
        "HarnessPublicBaseUrlSsmParam",
        "HarnessSlackAppSsmParam",
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
      "HarnessPublicBaseUrlSsmParam",
      "HarnessSlackAppSsmParam",
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

  it("sets HARNESS_API_SENTRY_DSN on every runtime Lambda when configured", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      sentryDsn: "https://abc123@o1.ingest.sentry.io/450",
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);
    const functions = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (fn) => fn.Properties?.Environment?.Variables?.HARNESS_DDB_PREFIX,
    );
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn.Properties?.Environment?.Variables?.HARNESS_API_SENTRY_DSN).toBe(
        "https://abc123@o1.ingest.sentry.io/450",
      );
    }
  });
});
