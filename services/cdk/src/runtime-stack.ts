import { fileURLToPath } from "node:url";

import { Aws, CfnOutput, Duration, Fn, Stack, type StackProps } from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

import { bootstrapSecretParams, grantBootstrapSecretsAccess } from "./bootstrap-secret-param.ts";
import type { FoundationResources } from "./foundation-stack.ts";
import { addLambdaIntegration } from "./runtime-api-integration.ts";

export type RuntimeStackProps = StackProps & {
  foundation: FoundationResources;
  tablePrefix: string;
};

export type RuntimeResources = {
  cronFunction: nodejs.NodejsFunction;
  cronRule: events.Rule;
  httpApi: apigatewayv2.CfnApi;
  restFunction: nodejs.NodejsFunction;
  websocketApi: apigatewayv2.CfnApi;
  websocketFunction: nodejs.NodejsFunction;
  restApiUrl: string;
  websocketUrl: string;
};

const lambdaEntry = fileURLToPath(new URL("../../api/src/lambda-handlers.ts", import.meta.url));

/** Synthesizable REST + WebSocket Lambda runtime. This construct never deploys by itself. */
export class AutoHarnessRuntimeStack extends Stack {
  readonly resources: RuntimeResources;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const { admins, cursorSecret, sessionSecret } = bootstrapSecretParams(this);
    const commonEnvironment = {
      ARCHIVE_BUCKET: props.foundation.archiveBucket.bucketName,
      HARNESS_ADMINS_SSM_PARAM: admins.param.valueAsString,
      HARNESS_CURSOR_SECRET_SSM_PARAM: cursorSecret.param.valueAsString,
      HARNESS_DDB_PREFIX: props.tablePrefix,
      HARNESS_SESSION_SECRET_SSM_PARAM: sessionSecret.param.valueAsString,
      KMS_KEY_ID: props.foundation.integrationKey.keyArn,
    };
    const functionProps = {
      bundling: { minify: true, sourceMap: true },
      entry: lambdaEntry,
      environment: commonEnvironment,
      memorySize: 256,
      runtime: lambda.Runtime.NODEJS_22_X,
    } satisfies Partial<nodejs.NodejsFunctionProps>;
    const restFunction = new nodejs.NodejsFunction(this, "RestFunction", {
      ...functionProps,
      handler: "rest",
      timeout: Duration.seconds(15),
    });
    const websocketFunction = new nodejs.NodejsFunction(this, "WebSocketFunction", {
      ...functionProps,
      handler: "websocket",
      timeout: Duration.seconds(30),
    });
    const cronFunction = new nodejs.NodejsFunction(this, "CronFunction", {
      ...functionProps,
      handler: "cron",
      timeout: Duration.seconds(60),
    });
    const apiDataAccessPolicy = iam.ManagedPolicy.fromManagedPolicyArn(
      this,
      "ImportedApiDataAccessPolicy",
      props.foundation.apiDataAccessPolicy.managedPolicyArn,
    );
    const archiveDataAccessPolicy = iam.ManagedPolicy.fromManagedPolicyArn(
      this,
      "ImportedArchiveDataAccessPolicy",
      props.foundation.archiveDataAccessPolicy.managedPolicyArn,
    );
    for (const fn of [restFunction, websocketFunction, cronFunction]) {
      fn.role!.addManagedPolicy(apiDataAccessPolicy);
      fn.role!.addManagedPolicy(archiveDataAccessPolicy);
      props.foundation.integrationKey.grantEncryptDecrypt(fn);
      grantBootstrapSecretsAccess(fn, { admins, cursorSecret, sessionSecret });
    }

    const httpApi = new apigatewayv2.CfnApi(this, "HttpApi", {
      name: `${this.stackName}-http`,
      protocolType: "HTTP",
    });
    const restIntegration = addLambdaIntegration(this, "Rest", httpApi, restFunction, "2.0");
    const restRoute = new apigatewayv2.CfnRoute(this, "RestDefaultRoute", {
      apiId: httpApi.ref,
      authorizationType: "NONE",
      routeKey: "$default",
      target: Fn.join("/", ["integrations", restIntegration.ref]),
    });
    const httpStage = new apigatewayv2.CfnStage(this, "HttpDefaultStage", {
      apiId: httpApi.ref,
      autoDeploy: true,
      stageName: "$default",
    });
    httpStage.addResourceDependency(restRoute);

    const websocketApi = new apigatewayv2.CfnApi(this, "WebSocketApi", {
      name: `${this.stackName}-websocket`,
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.type",
    });
    const websocketIntegration = addLambdaIntegration(
      this,
      "WebSocket",
      websocketApi,
      websocketFunction,
    );
    const websocketRoutes = ["$connect", "$disconnect", "$default"].map(
      (routeKey) =>
        new apigatewayv2.CfnRoute(this, `WebSocket${routeKey.slice(1)}Route`, {
          apiId: websocketApi.ref,
          authorizationType: "NONE",
          routeKey,
          target: Fn.join("/", ["integrations", websocketIntegration.ref]),
        }),
    );
    const websocketStage = new apigatewayv2.CfnStage(this, "WebSocketStage", {
      apiId: websocketApi.ref,
      autoDeploy: true,
      stageName: "prod",
    });
    for (const route of websocketRoutes) websocketStage.addResourceDependency(route);
    const websocketManagementEndpoint = Fn.join("", [
      "https://",
      websocketApi.ref,
      ".execute-api.",
      Aws.REGION,
      ".",
      Aws.URL_SUFFIX,
      "/prod",
    ]);
    websocketFunction.addEnvironment("WS_API_ENDPOINT", websocketManagementEndpoint);
    restFunction.addEnvironment("WS_API_ENDPOINT", websocketManagementEndpoint);
    cronFunction.addEnvironment("WS_API_ENDPOINT", websocketManagementEndpoint);
    const manageConnections = new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [
        Fn.join("", [
          "arn:",
          Aws.PARTITION,
          ":execute-api:",
          Aws.REGION,
          ":",
          Aws.ACCOUNT_ID,
          ":",
          websocketApi.ref,
          "/prod/POST/@connections/*",
        ]),
      ],
    });
    websocketFunction.addToRolePolicy(manageConnections);
    restFunction.addToRolePolicy(manageConnections);
    cronFunction.addToRolePolicy(manageConnections);

    const cronRule = new events.Rule(this, "CronRule", {
      description: "Runs durable Auto Harness scheduling and recovery once per minute.",
      schedule: events.Schedule.rate(Duration.minutes(1)),
    });
    cronRule.addTarget(new targets.LambdaFunction(cronFunction));

    const restApiUrl = httpApi.attrApiEndpoint;
    const websocketUrl = Fn.join("", [websocketApi.attrApiEndpoint, "/prod"]);
    void new CfnOutput(this, "RestApiUrl", { value: restApiUrl });
    void new CfnOutput(this, "WebSocketUrl", {
      value: websocketUrl,
    });
    void new CfnOutput(this, "IntegrationKeyArn", {
      value: props.foundation.integrationKey.keyArn,
    });

    this.resources = {
      cronFunction,
      cronRule,
      httpApi,
      restFunction,
      restApiUrl,
      websocketApi,
      websocketFunction,
      websocketUrl,
    };
  }
}
